/**
 * X API 的 HTTP 传输层（§6.1、§10.2、§10.3）。
 *
 * 职责边界：
 *   - 发起 fetch、解析 JSON、按 shared/errors 分类失败并抛出对应错误对象；
 *   - 429 时读取 x-rate-limit-reset / Retry-After 计算休眠时长（§10.3）；
 *   - 把响应头中的 rate limit 信息带回给调用方，供状态更新与成本采集（§18.5）；
 *   - 不理解业务，也不写数据库——状态推进由 x-monitor Worker 负责（§6.4）。
 *
 * fetch 通过参数注入，单测不发真实请求（vitest 直接传 stub）。
 */

import {
  classifyHttpStatus,
  computeRateLimitSleepMs,
  X_CONSECUTIVE_RATE_LIMIT_THRESHOLD,
  X_RATE_LIMIT_REMAINING_THRESHOLD,
} from '@x-square/shared';
import type { PollStatus } from '@x-square/shared';

import {
  XApiError,
  XAuthError,
  XNetworkError,
  XRateLimitError,
  XTimeoutError,
} from './errors.js';

/** 一次响应携带的元数据，供调用方更新账号状态与成本日志。 */
export interface XResponseMeta {
  httpStatus: number;
  /** x-rate-limit-remaining；缺失为 undefined。 */
  rateLimitRemaining?: number;
  /** x-rate-limit-reset，Unix 秒。 */
  rateLimitReset?: number;
}

/** 传输层构造参数。 */
export interface TransportOptions {
  /** fetch 实现，默认 globalThis.fetch。测试注入 stub。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时毫秒，默认 30_000。 */
  requestTimeoutMs?: number;
  /** 可注入时钟，便于测试 reset 计算。 */
  now?: () => number;
}

/** 网络错误码提取：Node fetch 把底层错误包在 cause 里。 */
export function networkErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const direct = (error as Error & { code?: string }).code;
    if (typeof direct === 'string') return direct;
    const cause = error.cause as { code?: string } | undefined;
    if (cause && typeof cause.code === 'string') return cause.code;
    // undici 的 HeadersTimeoutError / ConnectTimeoutError 等只有 name
    if (error.name.includes('Timeout')) return 'ETIMEDOUT';
  }
  return undefined;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 把 URL 脱敏成日志安全形式（仅 origin + path，query 丢弃）。 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/** 读取响应头构成元数据。 */
export function readMeta(response: Response): XResponseMeta {
  return {
    httpStatus: response.status,
    rateLimitRemaining: headerNumber(response.headers, 'x-rate-limit-remaining'),
    rateLimitReset: headerNumber(response.headers, 'x-rate-limit-reset'),
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '[body unreadable]';
  }
}

function truncateSafe(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 发起请求并按状态分类。成功时返回已解析 JSON 与元数据。
 *
 * 失败路径全部抛错（XApiError 族）：
 *   - 网络层异常 / AbortError → XNetworkError / XTimeoutError；
 *   - 429 → XRateLimitError（携带休眠时长，§10.3）；
 *   - 401/403 → XAuthError（Token 失效，§7.5）；
 *   - 其余按 classifyHttpStatus：5xx 为 retry，未登记状态为 fail（§10.2）。
 *
 * 本包全部是「读」请求：不存在发布类副作用窗口，published 恒 false。
 */
export async function requestJson(
  url: string,
  init: RequestInit,
  options: TransportOptions = {},
): Promise<{ json: unknown; meta: XResponseMeta }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new XTimeoutError(redactUrl(url));
    }
    throw new XNetworkError(networkErrorCode(error));
  } finally {
    clearTimeout(timer);
  }

  const meta = readMeta(response);

  if (response.ok) {
    const text = await safeText(response);
    const json: unknown = text.length === 0 ? {} : JSON.parse(text);
    return { json, meta };
  }

  if (response.status === 429) {
    const retryAfter = headerNumber(response.headers, 'retry-after');
    const sleepMs = computeRateLimitSleepMs(meta.rateLimitReset, retryAfter, now());
    throw new XRateLimitError(sleepMs, meta.rateLimitReset);
  }

  if (response.status === 401 || response.status === 403) {
    throw new XAuthError(response.status);
  }

  const disposition = classifyHttpStatus({ status: response.status });
  const detail = truncateSafe(await safeText(response), 500);
  throw new XApiError('XApiError', {
    disposition: { ...disposition, reason: `${disposition.reason}：${detail}` },
    httpStatus: response.status,
  });
}

/**
 * 轮询后应写入的 last_poll_status（§6.3）。
 *
 * remaining 低于阈值视为「即将被限流」，与 429 后同样置 RATE_LIMITED，
 * 让后台可见（§6.2 禁止写死无限循环请求）。
 */
export function derivePollStatus(meta: XResponseMeta): PollStatus {
  if (meta.httpStatus === 429) return 'RATE_LIMITED';
  if (meta.httpStatus === 401 || meta.httpStatus === 403) return 'AUTH_FAILED';
  if (meta.httpStatus >= 500) return 'SERVER_ERROR';
  if (
    meta.rateLimitRemaining !== undefined &&
    meta.rateLimitRemaining <= X_RATE_LIMIT_REMAINING_THRESHOLD
  ) {
    return 'RATE_LIMITED';
  }
  return 'OK';
}

/** 连续第 n 次 429 是否已达到「翻倍间隔」阈值（§10.3）。 */
export function shouldDoubleInterval(consecutiveRateLimits: number): boolean {
  return consecutiveRateLimits >= X_CONSECUTIVE_RATE_LIMIT_THRESHOLD;
}
