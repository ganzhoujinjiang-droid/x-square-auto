/**
 * X 帖子类型判定与 V1 同步策略（§8）。
 *
 * 判定完全依据 API 返回字段，不做任何网页抓取（§2）。
 */

/** 帖子类型（§8.1）。 */
export const POST_TYPE = {
  original: 'ORIGINAL',
  reply: 'REPLY',
  repost: 'REPOST',
  quote: 'QUOTE',
} as const;

export type PostType = (typeof POST_TYPE)[keyof typeof POST_TYPE];

/** 媒体类型（§8.1）。V1 只同步 photo，视频与 GIF 不同步。 */
export const MEDIA_TYPE = {
  photo: 'photo',
  video: 'video',
  animatedGif: 'animated_gif',
} as const;

export type MediaType = (typeof MEDIA_TYPE)[keyof typeof MEDIA_TYPE];

/** 帖子所含媒体的归类结果。 */
export type MediaKind = 'none' | 'photo' | 'video';

/** referenced_tweets 中 type 字段的取值（X API v2 规范）。 */
type ReferencedTweetType = 'replied_to' | 'retweeted' | 'quoted';

/** 判定所需的最小输入结构，避免耦合具体 API 响应类型。 */
export interface PostTypeInput {
  referencedTweets?: ReadonlyArray<{ type: string }> | null;
  /** attachments.media_keys 展开后的媒体类型集合 */
  mediaTypes?: ReadonlyArray<string> | null;
}

/**
 * 判定帖子类型（§8.1）：
 *
 *   referenced_tweets 为空或不存在           → ORIGINAL
 *   referenced_tweets[].type = "replied_to"  → REPLY
 *   referenced_tweets[].type = "retweeted"   → REPOST
 *   referenced_tweets[].type = "quoted"      → QUOTE
 *
 * 一条帖子理论上只会有一个 referenced_tweet；若出现多个（异常响应），
 * 按 replied_to > quoted > retweeted 的优先级取最保守的结果，
 * 因为 REPLY 默认不同步，保守判定可避免把回复误当原创发布。
 */
export function detectPostType(input: PostTypeInput): PostType {
  const referenced = input.referencedTweets ?? [];
  if (referenced.length === 0) {
    return POST_TYPE.original;
  }

  const types = new Set(referenced.map((item) => item.type as ReferencedTweetType));

  if (types.has('replied_to')) return POST_TYPE.reply;
  if (types.has('quoted')) return POST_TYPE.quote;
  if (types.has('retweeted')) return POST_TYPE.repost;

  // 未识别的 referenced type：按 REPLY 保守处理（默认不同步）
  return POST_TYPE.reply;
}

/**
 * 归类媒体（§8.1）：
 *
 *   存在 type = "photo"                       → 含图片
 *   存在 type = "video" / "animated_gif"      → 含视频（V1 不同步）
 *
 * 视频优先级高于图片：一条帖子若同时带 photo 与 video（X 实际不允许，
 * 但响应结构上可能），按 video 处理以确保不被误同步。
 */
export function detectMediaKind(mediaTypes: ReadonlyArray<string> | null | undefined): MediaKind {
  const types = mediaTypes ?? [];
  if (types.length === 0) {
    return 'none';
  }
  if (types.includes(MEDIA_TYPE.video) || types.includes(MEDIA_TYPE.animatedGif)) {
    return 'video';
  }
  if (types.includes(MEDIA_TYPE.photo)) {
    return 'photo';
  }
  return 'none';
}

/**
 * V1 默认同步策略（§8.2）。
 *
 * | 类型            | 默认行为      |
 * |-----------------|---------------|
 * | 原创纯文本      | ✅ 自动同步   |
 * | 原创 + 图片     | ✅ 自动同步   |
 * | Quote           | ❌ 不同步     |
 * | Reply           | ❌ 不同步     |
 * | Repost          | ❌ 不同步     |
 * | 含视频 / GIF    | ❌ 不同步     |
 *
 * 视频在 V1 不开放配置（§8.2「V1 不开放」），因此不在可配置集合中。
 */
export const DEFAULT_SYNC_POLICY: Readonly<Record<PostType, boolean>> = {
  [POST_TYPE.original]: true,
  [POST_TYPE.quote]: false,
  [POST_TYPE.reply]: false,
  [POST_TYPE.repost]: false,
};

/** 后台可配置的帖子类型开关（§17.5）。 */
export const CONFIGURABLE_POST_TYPES: readonly PostType[] = [
  POST_TYPE.original,
  POST_TYPE.quote,
  POST_TYPE.reply,
  POST_TYPE.repost,
];

/** 开启 Reply 时的风险提示（§17.5：二次确认 + 风险提示）。 */
export const REPLY_RISK_WARNING =
  'Reply 脱离上下文后在 Binance Square 上语义不完整，读者无法理解被回复的内容。不建议开启。';

/** 开启 Repost 时的版权风险提示（§17.5）。 */
export const REPOST_RISK_WARNING =
  'Repost 是他人创作的内容，自动转发到 Binance Square 存在版权风险。不建议开启。';

/** Quote 不同步的原因（§8.2）。 */
export const QUOTE_UNSUPPORTED_REASON =
  'Quote 需保留被引用帖的上下文，V1 的文本模板尚不支持该能力。';

/** 视频不同步的原因（§8.2）。 */
export const VIDEO_UNSUPPORTED_REASON = 'V1 不支持视频与 GIF 同步（需 ffmpeg，见 V2 规划）。';
