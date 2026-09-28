/**
 * Binance Square OpenAPI 客户端错误（§10.2、§11.4）。
 *
 * 每个错误自带 FailureDisposition，Worker 不需要重复分类：
 *   - fail      → FAILED，等待人工；
 *   - retry     → 保持原状态，退避后重试；
 *   - uncertain → UNCERTAIN，绝不自动重发（§9.3）。
 */

import {
  classifyBinanceCode,
  type FailureDisposition,
} from '@x-square/shared';

export class BinanceApiError extends Error {
  readonly disposition: FailureDisposition;
  readonly httpStatus?: number;
  /** Binance 业务 code（HTTP 成功但 code!=="000000" 时有值）。 */
  readonly binanceCode?: string;

  constructor(name: string, fields: {
    disposition: FailureDisposition;
    httpStatus?: number;
    binanceCode?: string;
  }) {
    super(fields.disposition.reason);
    this.name = name;
    this.disposition = fields.disposition;
    this.httpStatus = fields.httpStatus;
    this.binanceCode = fields.binanceCode;
  }
}

/** 业务错误码失败（§11.4 全表映射为 FAILED + 不重试）。 */
export class BinanceBusinessError extends BinanceApiError {
  /** 原始 message，供审计与人工判断留痕（§11.4）。 */
  readonly binanceMessage?: string;

  constructor(code: string, message?: string) {
    super('BinanceBusinessError', {
      disposition: classifyBinanceCode(code, message),
      binanceCode: code,
    });
    this.binanceMessage = message;
  }
}

/** 发布阶段的 504 / 超时 / 连接中断 → UNCERTAIN（§9.3）。 */
export class BinanceUncertainError extends BinanceApiError {
  constructor(reason: string) {
    super('BinanceUncertainError', {
      disposition: { kind: 'uncertain', reason },
    });
  }
}

/** 预签名 PUT 上传失败（非 2xx）。可重试，受 MEDIA_MAX_ATTEMPTS 约束（§12）。 */
export class BinanceUploadError extends BinanceApiError {
  constructor(status: number) {
    super('BinanceUploadError', {
      disposition: { kind: 'retry', reason: `预签名上传失败 HTTP ${status}` },
      httpStatus: status,
    });
  }
}
