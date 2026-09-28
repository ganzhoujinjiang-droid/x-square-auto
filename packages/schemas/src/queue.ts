/**
 * 队列任务载荷的 Zod schema（§10.1）。
 *
 * 任务经 Redis 序列化后跨进程传递，类型信息会丢失。Worker 消费前必须重新校验，
 * 否则崩溃恢复（§10.4）后重新分配的任务可能带着残缺字段运行。
 */

import { z } from 'zod';

import { BINANCE_SHORT_POST_MAX_IMAGES } from '@x-square/shared';

import { httpUrlSchema, snowflakeSchema, strictObject } from './common.js';

/**
 * 所有队列任务共有的字段。
 *
 * syncJobId 让处理器能回到数据库读取权威状态——§10.4 要求 publish-binance
 * 处理器第一步永远是「读取并校验当前 job 状态」，而非直接发请求。
 */
const baseJobPayload = {
  /** 对应 SyncJob.id（cuid），不是 X 侧 Tweet ID */
  syncJobId: z.string().min(1),
  /** X 侧 Tweet ID，便于日志检索（§20.2 的字段约定） */
  xPostId: snowflakeSchema,
  /** 入队时间戳，用于排查积压 */
  enqueuedAt: z.string(),
} as const;

/**
 * sync-post：规则过滤 + 内容处理入口（§10.1）。
 *
 * 只携带最小必要信息，规则本身从 settings 表读取——避免把规则快照塞进队列后，
 * 用户改了规则但队列里的旧任务仍按旧规则执行。
 */
export const syncPostPayloadSchema = strictObject({
  ...baseJobPayload,
  xAccountId: z.string().min(1),
});

export type SyncPostPayload = z.infer<typeof syncPostPayloadSchema>;

/**
 * process-content：文本模板 / AI 改写（§10.1）。
 *
 * §15.2 要求 AI 与 X Monitor 完全解耦、AI 故障自动降级为原样模式，
 * 因此 textMode 在此传递而非在处理器内部读配置，便于降级时改写载荷重试。
 */
export const processContentPayloadSchema = strictObject({
  ...baseJobPayload,
  /** raw / template / ai，见 @x-square/schemas 的 textModeSchema */
  textMode: z.enum(['raw', 'template', 'ai']),
});

export type ProcessContentPayload = z.infer<typeof processContentPayloadSchema>;

/**
 * download-media：从 X CDN 下载图片（§10.1、§12）。
 *
 * 限制：大小 ≤ 15MB，超时 30s，MIME 白名单 jpeg/png/webp。
 * 这些限制在处理器中执行，载荷只负责传递下载地址。
 */
export const downloadMediaPayloadSchema = strictObject({
  ...baseJobPayload,
  /**
   * X 媒体直链（photo 类型的 url 字段）。
   *
   * 这是 Worker 会真实发起 GET 抓取的地址（§12），因此协议必须限定为 http/https。
   * Zod 的 .url() 只校验语法，会放行 file:// 等协议——那等于让 X 的响应内容
   * 决定本系统去访问什么协议，是不可接受的。
   */
  sourceUrl: httpUrlSchema,
  mediaKey: z.string().min(1),
  /** 该图片在原帖附件中的序号，决定 imageList 的顺序（§12） */
  index: z.number().int().nonnegative(),
});

export type DownloadMediaPayload = z.infer<typeof downloadMediaPayloadSchema>;

/**
 * upload-media：预签名上传 + 轮询处理状态（§10.1、§11.1）。
 *
 * 注意 §11.3：图片上传失败也计入 400/日 配额，因此 download-media 阶段失败
 * 不应触发 upload-media 重试超过 2 次。attempt 由 BullMQ 维护，此处不重复计数。
 */
export const uploadMediaPayloadSchema = strictObject({
  ...baseJobPayload,
  /** 已下载到本地临时目录的路径，容器内 /tmp/x-square-media（§12） */
  localPath: z.string().min(1),
  /** 上传时使用的文件名，决定 Content-Type 映射（§11.1） */
  fileName: z.string().min(1),
  index: z.number().int().nonnegative(),
  binanceAccountId: z.string().min(1),
});

export type UploadMediaPayload = z.infer<typeof uploadMediaPayloadSchema>;

/**
 * publish-binance：调用 content/add（§10.1）。
 *
 * ⚠️ 这是「危险区」（§9.1 PUBLISHING 注释）。载荷中携带幂等键，
 * 处理器必须在发请求前用它查询是否已有 SUCCESS 记录（§9.4）。
 */
export const publishBinancePayloadSchema = strictObject({
  ...baseJobPayload,
  binanceAccountId: z.string().min(1),
  /** sha256(x_post_id + binance_account_id + content_hash)，§9.4 */
  idempotencyKey: z.string().min(1),
  /** 最终正文。已在 process-content 阶段渲染完毕，发布阶段不再改动 */
  bodyTextOnly: z.string().min(1),
  /** 已上传成功的 imageUrl 列表，按 X 原帖附件顺序（§12）；上限见 §11.2 */
  imageList: z
    .array(httpUrlSchema)
    .max(BINANCE_SHORT_POST_MAX_IMAGES, {
      message: `短帖最多 ${BINANCE_SHORT_POST_MAX_IMAGES} 张图片（§11.2）`,
    })
    .optional(),
  /**
   * 是否允许在结果为未知时转 UNCERTAIN。
   *
   * 恒为 true。保留此字段是为了让「禁止自动重试」这条约束在载荷层面显式可见，
   * 而不是只藏在处理器逻辑里（§9.3、§28 第五句原则）。
   */
  allowUncertain: z.literal(true).default(true),
});

export type PublishBinancePayload = z.infer<typeof publishBinancePayloadSchema>;

/**
 * reconcile-uncertain：UNCERTAIN 任务的定期核对（§10.1 标注为 V2）。
 *
 * V1 不启用该队列——§11.5 已确认 OpenAPI 不提供「读取/列出已发布帖子」的能力，
 * 因此无法自动对账，只能人工核对（§17.6）。schema 先登记以便 V2 复用。
 */
export const reconcileUncertainPayloadSchema = strictObject({
  ...baseJobPayload,
  binanceAccountId: z.string().min(1),
});

export type ReconcileUncertainPayload = z.infer<typeof reconcileUncertainPayloadSchema>;

/** 队列名 → 载荷 schema 的映射，供 Worker 统一取用。 */
export const QUEUE_PAYLOAD_SCHEMAS = {
  'sync-post': syncPostPayloadSchema,
  'process-content': processContentPayloadSchema,
  'download-media': downloadMediaPayloadSchema,
  'upload-media': uploadMediaPayloadSchema,
  'publish-binance': publishBinancePayloadSchema,
  'reconcile-uncertain': reconcileUncertainPayloadSchema,
} as const;

export type QueuePayloadSchemas = typeof QUEUE_PAYLOAD_SCHEMAS;
export type QueuePayloadName = keyof QueuePayloadSchemas;

/**
 * 按队列名解析并校验载荷。
 *
 * @throws z.ZodError 载荷不合法。按 §10.2 归类为不可重试、需人工介入。
 */
export function parseQueuePayload<K extends QueuePayloadName>(
  queueName: K,
  payload: unknown,
): z.infer<QueuePayloadSchemas[K]> {
  const schema = QUEUE_PAYLOAD_SCHEMAS[queueName] as z.ZodTypeAny;
  return schema.parse(payload) as z.infer<QueuePayloadSchemas[K]>;
}

/** 生成入队时间戳（UTC ISO 字符串，§20.4）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
