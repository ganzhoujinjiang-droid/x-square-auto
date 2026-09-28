/**
 * Binance Square OpenAPI 的 Zod schema（§11.1）。
 *
 * 已从官方源码逐行核实的要点：
 *   - 发布走 V1，图片走 V2，不可混用
 *   - 成功判定为响应体 code === "000000"（字符串，不是数字 0）
 *   - 正文字段是 bodyTextOnly，图片列表是 imageList，封面是 cover（单个 URL 字符串）
 *
 * ⚠️ 待验证（§26 风险 4、5）：图片状态轮询接口与预签名上传的响应结构来自官方 skill
 *    行为描述而非接口文档，属单源待校验。Phase 6 实现时若与真实响应不符，以真实响应为准。
 */

import { z } from 'zod';

import {
  BINANCE_CONTENT_TYPE,
  BINANCE_SHORT_POST_MAX_IMAGES,
  BINANCE_SUCCESS_CODE,
} from '@x-square/shared';

import { httpUrlSchema, nonEmptyStringSchema, strictObject } from './common.js';

// ---------------------------------------------------------------------------
// 统一响应包装
// ---------------------------------------------------------------------------

/**
 * Binance 统一响应结构：{ code, message, data }。
 *
 * code 是字符串。成功判定必须用 BINANCE_SUCCESS_CODE（"000000"）严格相等比较，
 * 不能写 if (code == 0)——那会把 "000000" 与 0 混为一谈，也会漏掉 "000001" 之类的失败码。
 */
export const binanceResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  strictObject({
    code: z.string(),
    message: z.string().optional(),
    data: dataSchema.optional(),
    success: z.boolean().optional(),
    traceId: z.string().optional(),
  });

/** 判断响应是否代表业务成功（§11.1）。 */
export function isBinanceSuccess(response: { code: string }): boolean {
  return response.code === BINANCE_SUCCESS_CODE;
}

// ---------------------------------------------------------------------------
// 端点一：POST {V2}/image/presignedUrl
// ---------------------------------------------------------------------------

/** 请求体：{ imageName }。 */
export const presignedUrlRequestSchema = strictObject({
  imageName: nonEmptyStringSchema,
});

export type PresignedUrlRequest = z.infer<typeof presignedUrlRequestSchema>;

/** 响应 data：{ presignedUrl, fileTicket }。 */
export const presignedUrlDataSchema = strictObject({
  /**
   * 对该 URL 执行 PUT 上传图片二进制；PUT 不带 X-Square-OpenAPI-Key（§11.1）。
   * 系统会真实向该地址发起写入请求，因此协议必须限定为 http/https。
   */
  presignedUrl: httpUrlSchema,
  fileTicket: z.string().min(1),
});

export const presignedUrlResponseSchema = binanceResponseSchema(presignedUrlDataSchema);

export type PresignedUrlResponse = z.infer<typeof presignedUrlResponseSchema>;
export type PresignedUrlData = z.infer<typeof presignedUrlDataSchema>;

// ---------------------------------------------------------------------------
// 端点二：POST {V2}/image/imageStatus
// ---------------------------------------------------------------------------

/** 请求体：{ fileTicket }。 */
export const imageStatusRequestSchema = strictObject({
  fileTicket: z.string().min(1),
});

/**
 * 响应 data：{ status: 0|1|2, imageUrl, failedReason }（§11.1）。
 *
 *   status = 1   处理完成，imageUrl 可用 → 返回
 *   status = 2   处理失败 → 抛错，携带 failedReason
 *   其他（如 0） 处理中 → 继续轮询
 *
 * status 用 z.number() 而非枚举：官方描述为「其他（如 0）」，暗示可能存在
 * 未列举的中间态，一律按「处理中」继续轮询，轮询超上限后按可重试错误处理。
 */
export const imageStatusDataSchema = strictObject({
  status: z.number().int(),
  /** 处理完成后的最终图片地址，会被填入 content/add 的 imageList，限定 http/https */
  imageUrl: httpUrlSchema.optional(),
  failedReason: z.string().optional(),
});

export const imageStatusResponseSchema = binanceResponseSchema(imageStatusDataSchema);

export type ImageStatusResponse = z.infer<typeof imageStatusResponseSchema>;
export type ImageStatusData = z.infer<typeof imageStatusDataSchema>;

// ---------------------------------------------------------------------------
// 端点三：POST {V1}/content/add
// ---------------------------------------------------------------------------

/**
 * 短帖请求体（contentType = 1，§11.1）。
 *
 * imageList 最多 4 张（§11.2）。图片与视频互斥；短帖模式不得带 title / cover。
 * 顺序即 X 原帖的附件顺序（§12：imageList 按原顺序传入）。
 */
export const shortPostRequestSchema = strictObject({
  contentType: z.literal(BINANCE_CONTENT_TYPE.shortPost),
  /**
   * 正文字段名是 bodyTextOnly，不是 content 也不是 text（§11.1）。
   *
   * $BTC 与 #topic 原样传递，由 Binance 服务端解析，客户端不得转义（§11.2、§14.2）。
   */
  bodyTextOnly: z.string().min(1, '正文不得为空（对应错误码 20020 / 220011）'),
  imageList: z
    .array(httpUrlSchema)
    .max(BINANCE_SHORT_POST_MAX_IMAGES, {
      message: `短帖最多 ${BINANCE_SHORT_POST_MAX_IMAGES} 张图片（§11.2）`,
    })
    .optional(),
});

export type ShortPostRequest = z.infer<typeof shortPostRequestSchema>;

/**
 * 长文章请求体（contentType = 2，§11.1）。
 *
 * V1 不实现（§22.2），schema 先行登记以便 V2 直接复用。
 * 约束：需要 title，cover 恰好 1 张且为单个 URL 字符串（不是数组），
 * 文章模式不能传 imageList（§11.2）。
 */
export const articlePostRequestSchema = strictObject({
  contentType: z.literal(BINANCE_CONTENT_TYPE.article),
  bodyTextOnly: z.string().min(1),
  title: nonEmptyStringSchema,
  /** 封面是单个 URL 字符串，不是数组（§11.1）；会被发往 Binance，限定 http/https */
  cover: httpUrlSchema.optional(),
});

export type ArticlePostRequest = z.infer<typeof articlePostRequestSchema>;

/** content/add 的请求体联合类型。 */
export const contentAddRequestSchema = z.discriminatedUnion('contentType', [
  shortPostRequestSchema,
  articlePostRequestSchema,
]);

export type ContentAddRequest = z.infer<typeof contentAddRequestSchema>;

/** 响应 data：{ id, shareLink }（§11.1）。 */
export const contentAddDataSchema = strictObject({
  id: z.union([z.string(), z.number()]).optional(),
  shareLink: z.string().optional(),
});

export const contentAddResponseSchema = binanceResponseSchema(contentAddDataSchema);

export type ContentAddResponse = z.infer<typeof contentAddResponseSchema>;

/**
 * 发布结果（§11.1 的 504 特判 + §9.3 的本系统决策）。
 *
 * published_with_id  明确成功且拿到 id —— 转 SUCCESS
 * published_without_id  官方 skill 对 504 的语义：视为已发布但拿不到 ID。
 *                       本系统不采纳该语义，改判 UNCERTAIN 等待人工确认（§9.3），
 *                       仅当用户在后台点击「确认已发布」时才落到 SUCCESS 且允许 id 为空。
 */
export const publishOutcomeSchema = z.enum([
  'published_with_id',
  'published_without_id',
]);

export type PublishOutcome = z.infer<typeof publishOutcomeSchema>;

/**
 * 校验短帖请求在发出前是否满足全部前置约束（§11.2）。
 *
 * 返回违规原因数组，空数组代表可以发布。在入队前调用，
 * 避免把注定失败的请求发出去浪费 100 帖/日 的配额（§11.3）。
 */
export function validateShortPost(request: ShortPostRequest): string[] {
  const violations: string[] = [];

  if (request.bodyTextOnly.trim() === '') {
    violations.push('正文为空（对应错误码 20020 / 220011）');
  }

  const imageCount = request.imageList?.length ?? 0;
  if (imageCount > 4) {
    violations.push(`短帖最多 4 张图片，实际 ${imageCount} 张`);
  }

  return violations;
}

/**
 * 从 content/add 响应中解析发布结果。
 *
 * @returns id 存在时为 published_with_id；成功但无 id 时为 published_without_id
 */
export function parsePublishOutcome(
  data: { id?: string | number; shareLink?: string } | undefined,
): { outcome: PublishOutcome; postId: string | null; postUrl: string | null } {
  const rawId = data?.id;
  const postId =
    rawId === undefined || rawId === null || rawId === ''
      ? null
      : typeof rawId === 'number'
        ? String(rawId)
        : rawId;

  return {
    outcome: postId === null ? 'published_without_id' : 'published_with_id',
    postId,
    postUrl: data?.shareLink ?? null,
  };
}
