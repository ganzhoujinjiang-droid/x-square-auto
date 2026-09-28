/**
 * Binance Square OpenAPI 传输层（§11.1）。
 *
 * 三个接口全部是 POST + JSON body，统一请求头：
 *   X-Square-OpenAPI-Key / Content-Type: application/json / clienttype: binanceSkill
 *
 * ⚠️ Base URL 双版本不可混用：发布走 V1，图片走 V2（§11.1 最容易踩的坑）。
 * 成功判定是响应体 code === "000000"（字符串），不是 HTTP 状态码。
 */

import {
  classifyHttpStatus,
  BINANCE_CLIENT_TYPE,
  type FailureDisposition,
} from '@x-square/shared';

import { BinanceApiError, BinanceBusinessError } from './errors.js';

/** 客户端构造参数。apiKey 只在内存流转，绝不写日志（§7.6、§11.6）。 */
export interface BinanceTransportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** 单次请求超时毫秒，默认 30_000。 */
  requestTimeoutMs?: number;
}

/** 一次 POST 的结果：原始 Response 交上层解析。 */
export interface RawPostResult {
  status: number;
  json: unknown;
}

/** 网络错误码提取（同 x-client，Node fetch 包装在 cause）。 */
function networkErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const direct = (error as Error & { code?: string }).code;
    if (typeof direct === 'string') return direct;
    const cause = error.cause as { code?: string } | undefined;
    if (cause && typeof cause.code === 'string') return cause.code;
    if (error.name.includes('Timeout')) return 'ETIMEDOUT';
  }
  return undefined;
}

/**
 * 发起带标准头的 POST JSON。
 *
 * @param published 是否「发布类请求」（content/add）。决定 504/超时的归类：
 *   发布阶段 → uncertain（§9.3）；其他阶段按普通可重试处理。
 */
export async function postJson(
  url: string,
  body: unknown,
  options: BinanceTransportOptions & { published?: boolean },
): Promise<RawPostResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Square-OpenAPI-Key': options.apiKey,
        'Content-Type': 'application/json',
        clienttype: BINANCE_CLIENT_TYPE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw classifyPublishFailure(options.published === true, '请求超时');
    }
    const code = networkErrorCode(error);
    // ECONNRESET/EPIPE 发生在发布阶段意味着结果未知（§9.3）
    if (
      options.published === true &&
      (code === 'ECONNRESET' || code === 'EPIPE')
    ) {
      throw classifyPublishFailure(true, `连接中断 ${code}`);
    }
    throw new BinanceApiError('BinanceNetworkError', {
      disposition: { kind: 'retry', reason: `网络错误 ${code ?? 'UNKNOWN'}，退避重试` },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const disposition = classifyHttpStatus({
      status: response.status,
      published: options.published === true,
    });
    throw new BinanceApiError('BinanceHttpError', {
      disposition,
      httpStatus: response.status,
    });
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    if (options.published === true) {
      // 发布阶段拿到非 JSON（网关 HTML 等）：请求已发出，结果未知（§9.3）
      throw classifyPublishFailure(true, '响应不是合法 JSON');
    }
    throw new BinanceApiError('BinanceParseError', {
      disposition: { kind: 'fail', reason: '响应不是合法 JSON，可能接口变更，需人工介入' },
      httpStatus: response.status,
    });
  }
  return { status: response.status, json };
}

/** 把「发布阶段的失败」统一转成 uncertain 错误对象。 */
function classifyPublishFailure(published: boolean, detail: string): BinanceApiError {
  if (published) {
    return new BinanceApiError('BinanceUncertainError', {
      disposition: {
        kind: 'uncertain',
        reason: `${detail}：发布请求已发出但结果未知，需人工核对`,
      },
    });
  }
  return new BinanceApiError('BinanceRetryableError', {
    disposition: { kind: 'retry', reason: `${detail}，退避重试` },
  });
}

/** 业务层成功判定：code === "000000"（字符串，§11.1）。 */
export function assertBusinessSuccess(
  envelope: { code?: unknown; message?: unknown },
): void {
  if (String(envelope.code ?? '') !== '000000') {
    throw new BinanceBusinessError(
      String(envelope.code ?? ''),
      typeof envelope.message === 'string' ? envelope.message : undefined,
    );
  }
}
