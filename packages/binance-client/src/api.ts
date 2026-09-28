/**
 * Binance Square 三个端点（§11.1）。
 *
 * ⚠️ Base URL 双版本：发布走 V1，图片走 V2。全部用 V2 会导致 /content/add 失败。
 * 本文件把两条路径分别绑定到对应常量，从代码结构上杜绝混用。
 */

import { z } from 'zod';

import {
  imageStatusResponseSchema,
  presignedUrlResponseSchema,
  contentAddResponseSchema,
  shortPostRequestSchema,
  validateShortPost,
  parsePublishOutcome,
  type PresignedUrlData,
  type ImageStatusData,
  type ShortPostRequest,
  type PublishOutcome,
} from '@x-square/schemas';
import {
  BINANCE_SQUARE_V1_BASE_URL,
  BINANCE_SQUARE_V2_BASE_URL,
  MEDIA_EXTENSION_CONTENT_TYPE,
  MEDIA_FALLBACK_CONTENT_TYPE,
  extractExtension,
} from '@x-square/shared';

import { BinanceApiError, BinanceUploadError } from './errors.js';
import {
  assertBusinessSuccess,
  postJson,
  type BinanceTransportOptions,
} from './http.js';

/** 按文件名/URL 扩展名映射 Content-Type（§11.1 PUT 规则）。 */
export function contentTypeForImage(nameOrUrl: string): string {
  const ext = extractExtension(nameOrUrl);
  if (ext === null) return MEDIA_FALLBACK_CONTENT_TYPE;
  return MEDIA_EXTENSION_CONTENT_TYPE[ext] ?? MEDIA_FALLBACK_CONTENT_TYPE;
}

/** 信封解析顺序：先按 {code,message} 判业务成败，再校验成功时的 data。 */
const envelopeLooseSchema = z
  .object({ code: z.string(), message: z.string().optional() })
  .passthrough();

function parseEnvelope<T>(
  json: unknown,
  endpoint: string,
  pickData: (envelope: { code?: unknown; message?: unknown }) => T | undefined,
): T {
  const loose = envelopeLooseSchema.safeParse(json);
  if (!loose.success) {
    throw new BinanceApiError('BinanceSchemaError', {
      disposition: { kind: 'fail', reason: `${endpoint} 响应缺少 code 字段，可能接口变更` },
    });
  }
  assertBusinessSuccess(loose.data);
  const data = pickData(loose.data);
  if (data === undefined) {
    throw new BinanceApiError('BinanceSchemaError', {
      disposition: { kind: 'fail', reason: `${endpoint} 业务成功但 data 缺失/结构不符` },
    });
  }
  return data;
}

/** 端点一：获取预签名上传地址（V2，§11.1）。 */
export async function getPresignedUrl(
  imageName: string,
  options: BinanceTransportOptions,
): Promise<PresignedUrlData> {
  const { json } = await postJson(
    `${BINANCE_SQUARE_V2_BASE_URL}/image/presignedUrl`,
    { imageName },
    options,
  );
  return parseEnvelope(json, '/image/presignedUrl', (envelope) => {
    const parsed = presignedUrlResponseSchema.safeParse(envelope);
    return parsed.success ? parsed.data.data : undefined;
  });
}

/**
 * 对预签名 URL 执行 PUT 上传（§11.1）。
 *
 * 注意：这一步不带 X-Square-OpenAPI-Key——凭据已包含在预签名 URL 中。
 * 非 2xx 即上传失败（可重试，受 §12 的 2 次上限约束）。
 */
export async function uploadToPresignedUrl(
  presignedUrl: string,
  data: Buffer | Uint8Array,
  imageName: string,
  options: Pick<BinanceTransportOptions, 'fetchImpl' | 'requestTimeoutMs'> = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentTypeForImage(imageName) },
    body: data as unknown as Exclude<RequestInit['body'], symbol>,
  });
  if (!response.ok) {
    throw new BinanceUploadError(response.status);
  }
}

/** 端点二：轮询图片处理状态（V2，§11.1）。单次调用，循环由 image-worker 控制。 */
export async function getImageStatus(
  fileTicket: string,
  options: BinanceTransportOptions,
): Promise<ImageStatusData> {
  const { json } = await postJson(
    `${BINANCE_SQUARE_V2_BASE_URL}/image/imageStatus`,
    { fileTicket },
    options,
  );
  return parseEnvelope(json, '/image/imageStatus', (envelope) => {
    const parsed = imageStatusResponseSchema.safeParse(envelope);
    return parsed.success ? parsed.data.data : undefined;
  });
}

/** 发布结果（§9.3 + §11.1 的 504 特判语义）。 */
export interface PublishResult {
  outcome: PublishOutcome;
  postId: string | null;
  postUrl: string | null;
}

/**
 * 端点三：发布短帖（V1 /content/add，§11.1）。
 *
 * 发出前先做 §11.2 前置校验（空正文、>4 图），避免浪费 100 帖/日配额。
 * published=true 语境下 HTTP 504 / 超时 / ECONNRESET → uncertain（§9.3），
 * 绝不自动重发。成功但无 id 返回 published_without_id，由上层决定是否人工确认。
 */
export async function publishShortPost(
  request: ShortPostRequest,
  options: BinanceTransportOptions,
): Promise<PublishResult> {
  // 入队前的硬校验（§11.3）：违规直接 fail-fast，不发请求
  const violations = validateShortPost(request);
  if (violations.length > 0) {
    throw new BinanceApiError('BinancePreflightError', {
      disposition: { kind: 'fail', reason: `发布前置校验未通过：${violations.join('；')}` },
    });
  }
  const checked = shortPostRequestSchema.parse(request);

  const { json } = await postJson(
    `${BINANCE_SQUARE_V1_BASE_URL}/content/add`,
    checked,
    { ...options, published: true },
  );

  // 发布阶段：任何「看不懂」的响应都按结果未知处理，绝不盲目重试（§9.3）
  const loose = envelopeLooseSchema.safeParse(json);
  if (!loose.success) {
    throw new BinanceApiError('BinanceUncertainError', {
      disposition: {
        kind: 'uncertain',
        reason: '/content/add 响应无法解析，发布结果未知，需人工核对',
      },
    });
  }
  assertBusinessSuccess(loose.data);

  const parsed = contentAddResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new BinanceApiError('BinanceUncertainError', {
      disposition: {
        kind: 'uncertain',
        reason: '/content/add 业务成功但 data 结构异常，发布结果未知，需人工核对',
      },
    });
  }
  return parsePublishOutcome(parsed.data.data);
}
