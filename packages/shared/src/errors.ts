/**
 * 错误分类与 Binance 错误码映射（§10.2、§11.4）。
 *
 * 核心原则（§11.4 末尾）：任何未在映射表中的 Binance 错误码一律按
 * FAILED + 不重试处理，并记录原始 code/message 供人工判断，
 * 绝不乐观地当作可重试。
 */

import { JOB_STATUS, type JobStatus } from './job-status.js';

/** 系统对一次失败的处置决定。 */
export type FailureDisposition =
  /** 可重试：自动退避后重新入队（§10.2）。 */
  | { kind: 'retry'; reason: string }
  /** 不可重试：直接 FAILED，等待人工（§10.2）。 */
  | { kind: 'fail'; reason: string }
  /**
   * 结果未知：转 UNCERTAIN，不进入重试队列（§9.3）。
   *
   * 这是本系统最重要的分支——请求已发出但不知道对端是否处理成功，
   * 自动重试可能造成同一内容重复发布。
   */
  | { kind: 'uncertain'; reason: string };

/** 处置决定对应的目标状态，便于调用方统一处理。 */
export function dispositionToStatus(
  disposition: FailureDisposition,
): JobStatus | null {
  switch (disposition.kind) {
    case 'fail':
      return JOB_STATUS.failed;
    case 'uncertain':
      return JOB_STATUS.uncertain;
    case 'retry':
      // 重试期间保持原状态（§11.4 表格中「保持原状态」），由调用方决定何时入队
      return null;
  }
}

/**
 * Binance Square OpenAPI 错误码映射表（§11.4）。
 *
 * 键为 Binance 返回的 code 字符串。全部映射为 FAILED + 不重试。
 */
const BINANCE_ERROR_CODES: Readonly<Record<string, string>> = {
  '220003': '密钥无效，请重新填写',
  '220004': '密钥已过期，请到创作者中心重新生成',
  '220009': '今日 100 帖已达上限，UTC 0 点后自动恢复',
  '220014': '今日 400 次上传已达上限',
  '20002': '内容命中平台敏感词，需人工修改',
  '20022': '内容命中平台敏感词，需人工修改',
  '20013': '正文超长，需截断或人工处理',
  '20020': '处理后正文为空，检查过滤规则',
  '220011': '处理后正文为空，检查过滤规则',
  '30008': '账号被平台限制，请联系 Binance',
  '2000001': '账号或设备发帖受限，请联系 Binance',
  '2000002': '账号或设备发帖受限，请联系 Binance',
};

/** 判断某 Binance code 是否已在映射表中登记。 */
export function isKnownBinanceErrorCode(code: string): boolean {
  return Object.hasOwn(BINANCE_ERROR_CODES, code);
}

/**
 * 按 Binance code 给出处置（§11.4）。
 *
 * 未登记的 code 一律 FAILED + 不重试（§11.4 末尾的保守原则）。
 */
export function classifyBinanceCode(code: string, message?: string): FailureDisposition {
  const known = BINANCE_ERROR_CODES[code];
  return {
    kind: 'fail',
    reason: known ?? `未登记的 Binance 错误码 ${code}${message ? `：${message}` : ''}`,
  };
}

/** 取得某 Binance code 的用户可见提示文案；未登记时返回 null。 */
export function binanceCodeHint(code: string): string | null {
  return BINANCE_ERROR_CODES[code] ?? null;
}

/** 可重试的 HTTP 状态码（§10.2）。504 单独归入 uncertain，不在此列。 */
const RETRYABLE_HTTP_STATUSES: readonly number[] = [500, 502, 503];

/** 可重试的网络层错误码（§10.2）。 */
const RETRYABLE_NETWORK_CODES: readonly string[] = [
  'EAI_AGAIN', // DNS 暂时失败
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

/**
 * 结果未知的网络层错误码。
 *
 * 请求已发出后连接被重置，无法判断对端是否已处理，必须走 UNCERTAIN（§9.3）。
 */
const UNCERTAIN_NETWORK_CODES: readonly string[] = ['ECONNRESET', 'EPIPE'];

/** 认证失败的 HTTP 状态码（§10.2）：Token 或 API Key 失效，不可重试。 */
const AUTH_FAILURE_HTTP_STATUSES: readonly number[] = [401, 403];

/** 限流状态码。 */
const RATE_LIMIT_HTTP_STATUS = 429;

/** 发布结果未知的状态码（§9.3）。 */
const UNCERTAIN_HTTP_STATUS = 504;

/** HTTP 层失败的处置输入。 */
export interface HttpFailureInput {
  status: number;
  /** 是否发生在「请求已发出、等待响应」的发布阶段。决定 504 是否转 UNCERTAIN。 */
  published?: boolean;
}

/**
 * 按 HTTP 状态码分类（§10.2、§11.4）。
 *
 * @param input.published 仅发布阶段（content/add 已发出）的 504 才转 UNCERTAIN。
 *   非发布阶段的 504（例如图片状态轮询）按普通 5xx 重试处理，因为此时
 *   还没有产生「可能已发布」的副作用。
 */
export function classifyHttpStatus(input: HttpFailureInput): FailureDisposition {
  const { status } = input;

  if (AUTH_FAILURE_HTTP_STATUSES.includes(status)) {
    return { kind: 'fail', reason: `HTTP ${status}：Token 或 API Key 失效` };
  }

  if (status === RATE_LIMIT_HTTP_STATUS) {
    return { kind: 'retry', reason: 'HTTP 429：限流，按 reset 头退避' };
  }

  // §9.3：发布阶段的 504 → UNCERTAIN，绝不自动重试
  if (status === UNCERTAIN_HTTP_STATUS && input.published === true) {
    return {
      kind: 'uncertain',
      reason: 'HTTP 504：发布请求已发出但结果未知，需人工核对',
    };
  }

  if (RETRYABLE_HTTP_STATUSES.includes(status)) {
    return { kind: 'retry', reason: `HTTP ${status}：服务端错误，指数退避` };
  }

  // 未登记的 4xx / 5xx：保守处理为不可重试（§11.4 末尾原则）
  return { kind: 'fail', reason: `HTTP ${status}：未预期的响应状态` };
}

/**
 * 按网络层错误分类（§10.2）。
 *
 * @param published 同 classifyHttpStatus，决定连接中断是否意味着「结果未知」。
 */
export function classifyNetworkError(
  code: string | undefined,
  options: { published?: boolean } = {},
): FailureDisposition {
  const normalized = code ?? 'UNKNOWN';

  if (options.published === true && UNCERTAIN_NETWORK_CODES.includes(normalized)) {
    return {
      kind: 'uncertain',
      reason: `${normalized}：发布请求已发出后连接中断，结果未知，需人工核对`,
    };
  }

  if (RETRYABLE_NETWORK_CODES.includes(normalized)) {
    return { kind: 'retry', reason: `${normalized}：网络暂时故障，指数退避` };
  }

  return { kind: 'fail', reason: `未预期的网络错误 ${normalized}` };
}

/** Zod 校验失败：响应结构不符预期，可能是接口变更，需人工介入（§10.2）。 */
export const SCHEMA_VALIDATION_DISPOSITION: FailureDisposition = {
  kind: 'fail',
  reason: 'Zod 校验失败：响应结构不符预期，可能是接口变更，需人工介入',
};

/** 超时：发布阶段视为结果未知，其他阶段可重试（§10.2、§9.3）。 */
export function classifyTimeout(options: { published?: boolean } = {}): FailureDisposition {
  if (options.published === true) {
    return {
      kind: 'uncertain',
      reason: '请求超时：发布结果未知，需人工核对',
    };
  }
  return { kind: 'retry', reason: '网络超时，指数退避' };
}

/** 自定义退避：30s / 60s / 120s / 300s / 600s（§10.1）。 */
const BACKOFF_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 600_000,
];

/**
 * BullMQ custom backoff 的计算函数。
 *
 * 超出序列长度后固定取最后一档，避免指数爆炸（§10.1）。
 */
export function computeBackoffDelay(attempt: number): number {
  const index = Math.max(0, attempt - 1);
  const delay = BACKOFF_DELAYS_MS[index];
  return delay ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1] ?? 600_000;
}

/**
 * 429 休眠时长计算（§10.3）：
 *
 *   sleep = max(reset - now, Retry-After, 1s)
 *
 * @param rateLimitReset Unix 秒，来自 x-rate-limit-reset 响应头
 * @param retryAfterSec  秒，来自 Retry-After 响应头（若存在则优先参与比较）
 * @param nowMs          当前时间戳（毫秒），默认 Date.now()
 */
export function computeRateLimitSleepMs(
  rateLimitReset: number | undefined,
  retryAfterSec: number | undefined,
  nowMs: number = Date.now(),
): number {
  const MIN_SLEEP_MS = 1000;
  const candidates: number[] = [MIN_SLEEP_MS];

  if (typeof rateLimitReset === 'number' && Number.isFinite(rateLimitReset)) {
    candidates.push(rateLimitReset * 1000 - nowMs);
  }
  if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec)) {
    candidates.push(retryAfterSec * 1000);
  }

  return Math.max(...candidates, MIN_SLEEP_MS);
}

/**
 * 连续 429 后的间隔翻倍（§10.3）。
 *
 * 连续 3 次 429 → 轮询间隔翻倍，最高 300s，并在后台告警。
 */
export function nextPollIntervalAfterRateLimit(
  currentSec: number,
  consecutiveRateLimits: number,
  options: { threshold?: number; maxSec?: number } = {},
): number {
  const threshold = options.threshold ?? 3;
  const maxSec = options.maxSec ?? 300;
  if (consecutiveRateLimits < threshold) {
    return currentSec;
  }
  return Math.min(currentSec * 2, maxSec);
}
