/**
 * X API 客户端错误类型（§10.2）。
 *
 * 每个错误都携带 shared/errors 的 FailureDisposition，让调用方（Worker）
 * 不必重新实现分类逻辑——HTTP 状态、网络错误码、Zod 校验失败在这里就已经
 * 归类完毕（§10.2 的可重试 / 不可重试 / UNCERTAIN 三分法）。
 */

import {
  classifyNetworkError,
  type FailureDisposition,
} from '@x-square/shared';

/** 客户端错误的公共字段。 */
export interface XClientErrorFields {
  /** 分类结果：retry / fail / uncertain（§10.2）。 */
  disposition: FailureDisposition;
  /** HTTP 状态码（网络层错误时 undefined）。 */
  httpStatus?: number;
  /** 429 场景下应休眠的毫秒数（§10.3 计算结果）。 */
  retryAfterMs?: number;
}

/**
 * X API 调用失败的统一错误。
 *
 * 命名以 Error 结尾以符合 Error 子类约定；message 只包含可安全写日志的
 * 信息，绝不包含 Token（§7.6 日志红线）。
 */
export class XApiError extends Error {
  readonly disposition: FailureDisposition;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(name: string, fields: XClientErrorFields) {
    super(fields.disposition.reason);
    this.name = name;
    this.disposition = fields.disposition;
    this.httpStatus = fields.httpStatus;
    this.retryAfterMs = fields.retryAfterMs;
  }
}

/** 429：携带退避时长，调用方据此休眠（§10.3）。 */
export class XRateLimitError extends XApiError {
  constructor(retryAfterMs: number, resetSec: number | undefined) {
    super('XRateLimitError', {
      disposition: {
        kind: 'retry',
        reason:
          'HTTP 429：限流' +
          (resetSec !== undefined
            ? `，休眠至 ${new Date(resetSec * 1000).toISOString()}`
            : ''),
      },
      httpStatus: 429,
      retryAfterMs,
    });
  }
}

/** 401 / 403：Token 失效，账号应转 TOKEN_EXPIRED（§7.5）。 */
export class XAuthError extends XApiError {
  constructor(status: number) {
    super('XAuthError', {
      disposition: {
        kind: 'fail',
        reason: `HTTP ${status}：Token 失效或被拒绝，需重新授权`,
      },
      httpStatus: status,
    });
  }
}

/** 响应结构不符合 Zod schema：可能接口变更，按不可重试处理（§10.2）。 */
export class XSchemaValidationError extends XApiError {
  constructor(endpoint: string, detail: string) {
    super('XSchemaValidationError', {
      disposition: {
        kind: 'fail',
        reason: `${endpoint} 响应校验失败：${detail}`,
      },
    });
  }
}

/** 请求超时（AbortController 触发）。读取阶段超时不可能是「发布结果未知」（只读 API），恒为 retry。 */
export class XTimeoutError extends XApiError {
  constructor(endpoint: string) {
    super('XTimeoutError', {
      disposition: { kind: 'retry', reason: `${endpoint} 请求超时，指数退避` },
    });
  }
}

/** 传输层错误（DNS / ECONNRESET 等）。 */
export class XNetworkError extends XApiError {
  constructor(code: string | undefined) {
    super('XNetworkError', {
      // 本包只读 X 数据：不存在「已发出写入但结果未知」的窗口，
      // published 恒为 false（§10.2）。
      disposition: classifyNetworkError(code, { published: false }),
    });
  }
}
