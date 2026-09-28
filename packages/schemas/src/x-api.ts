/**
 * X API v2 响应的 Zod schema（§6.1、§8.1）。
 *
 * 字段清单严格对应 §6.1 中声明的 expansions / tweet.fields / media.fields / user.fields，
 * 不多请求、不多校验。
 *
 * ⚠️ 校验失败按「不可重试 + 需人工介入」处理（§10.2）。X 若新增字段，
 *    应显式登记到本文件，而不是放宽为 passthrough——静默忽略会让接口变更无人察觉。
 */

import { z } from 'zod';

import { httpUrlSchema, isoDateTimeSchema, snowflakeSchema, strictObject } from './common.js';

// ---------------------------------------------------------------------------
// entities（§6.1 tweet.fields）
// ---------------------------------------------------------------------------

/** 帖子中的 URL 实体。 */
export const xEntityUrlSchema = strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  url: z.string(),
  expanded_url: z.string().optional(),
  display_url: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.number().optional(),
  images: z
    .array(strictObject({ url: z.string(), width: z.number(), height: z.number() }))
    .optional(),
});

/** 帖子中的 hashtag 实体。 */
export const xEntityHashtagSchema = strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  tag: z.string(),
});

/** 帖子中的 mention 实体。 */
export const xEntityMentionSchema = strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  username: z.string(),
});

/** 帖子中的 cashtag 实体（$BTC）。§14.2：原样传递，不做转义。 */
export const xEntityCashtagSchema = strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  tag: z.string(),
});

export const xEntitiesSchema = strictObject({
  urls: z.array(xEntityUrlSchema).optional(),
  hashtags: z.array(xEntityHashtagSchema).optional(),
  mentions: z.array(xEntityMentionSchema).optional(),
  cashtags: z.array(xEntityCashtagSchema).optional(),
  annotations: z
    .array(
      strictObject({
        start: z.number(),
        end: z.number(),
        probability: z.number(),
        type: z.string(),
        normalized_text: z.string(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// attachments / referenced_tweets
// ---------------------------------------------------------------------------

export const xAttachmentsSchema = strictObject({
  media_keys: z.array(z.string()).optional(),
  poll_ids: z.array(z.string()).optional(),
});

/**
 * referenced_tweets（§8.1 的类型判定依据）。
 *
 * type 用 z.string() 而非枚举：X 可能新增类型，而 detectPostType 对未识别类型
 * 已做保守降级（按 REPLY 处理，默认不同步），无需在此处硬失败。
 */
export const xReferencedTweetSchema = strictObject({
  type: z.string(),
  id: snowflakeSchema,
});

// ---------------------------------------------------------------------------
// media（§6.1 media.fields）
// ---------------------------------------------------------------------------

/**
 * 媒体对象。
 *
 * type 用枚举：§8.1 明确区分 photo / video / animated_gif，
 * 且 V1 只同步 photo，视频必须在判定阶段就被准确识别。
 */
export const xMediaSchema = strictObject({
  media_key: z.string(),
  type: z.enum(['photo', 'video', 'animated_gif']),
  /**
   * photo 类型为直链，会被 download-media 直接抓取（§12），因此必须限定 http/https。
   * video 需 variants，V1 不处理。
   */
  url: httpUrlSchema.optional(),
  preview_image_url: httpUrlSchema.optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  alt_text: z.string().optional(),
  duration_ms: z.number().int().optional(),
  variants: z
    .array(
      strictObject({
        bit_rate: z.number().int().optional(),
        content_type: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
  public_metrics: z
    .strictObject({ view_count: z.number().int().optional() })
    .optional(),
  non_public_metrics: z.record(z.string(), z.number()).optional(),
  organic_metrics: z.record(z.string(), z.number()).optional(),
  promoted_metrics: z.record(z.string(), z.number()).optional(),
});

// ---------------------------------------------------------------------------
// tweet（§6.1 tweet.fields）
// ---------------------------------------------------------------------------

export const xTweetSchema = strictObject({
  id: snowflakeSchema,
  text: z.string(),
  created_at: isoDateTimeSchema,
  author_id: snowflakeSchema.optional(),
  conversation_id: snowflakeSchema.optional(),
  attachments: xAttachmentsSchema.optional(),
  entities: xEntitiesSchema.optional(),
  referenced_tweets: z.array(xReferencedTweetSchema).optional(),
  edit_history_tweet_ids: z.array(snowflakeSchema).optional(),
  reply_settings: z.enum(['following', 'mentionedUsers', 'subscribers', 'everyone']).optional(),
  lang: z.string().optional(),
  possibly_sensitive: z.boolean().optional(),
});

export type XTweet = z.infer<typeof xTweetSchema>;
export type XMedia = z.infer<typeof xMediaSchema>;

// ---------------------------------------------------------------------------
// includes（expansions 展开结果）
// ---------------------------------------------------------------------------

/** §6.1 user.fields=id,username —— 只请求这两个字段。 */
export const xUserSchema = strictObject({
  id: snowflakeSchema,
  username: z.string(),
});

export const xIncludesSchema = strictObject({
  media: z.array(xMediaSchema).optional(),
  tweets: z.array(xTweetSchema).optional(),
  users: z.array(xUserSchema).optional(),
  polls: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// 分页 meta
// ---------------------------------------------------------------------------

export const xPaginationMetaSchema = strictObject({
  newest_id: snowflakeSchema.optional(),
  oldest_id: snowflakeSchema.optional(),
  result_count: z.number().int().nonnegative().optional(),
  next_token: z.string().optional(),
  previous_token: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /2/users/{id}/tweets 完整响应
// ---------------------------------------------------------------------------

/**
 * 时间线响应。
 *
 * §18.2 的成本模型依赖 result_count 与 data 长度：计费单位是「响应中返回的资源数」，
 * 空响应返回 0 个资源、不产生费用。因此 data 缺失时必须视为空数组而非错误。
 */
export const xUserTweetsResponseSchema = strictObject({
  data: z.array(xTweetSchema).optional(),
  includes: xIncludesSchema.optional(),
  meta: xPaginationMetaSchema.optional(),
  errors: z
    .array(
      strictObject({
        title: z.string().optional(),
        detail: z.string().optional(),
        type: z.string().optional(),
        resource_type: z.string().optional(),
        parameter: z.string().optional(),
        value: z.string().optional(),
        section: z.string().optional(),
        parameters: z.record(z.string(), z.array(z.string())).optional(),
      }),
    )
    .optional(),
});

export type XUserTweetsResponse = z.infer<typeof xUserTweetsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /2/users/me（§7.1：授权后记录 x_user_id / username）
// ---------------------------------------------------------------------------

export const xUserMeResponseSchema = strictObject({
  data: strictObject({
    id: snowflakeSchema,
    username: z.string(),
    name: z.string().optional(),
  }),
});

export type XUserMeResponse = z.infer<typeof xUserMeResponseSchema>;

// ---------------------------------------------------------------------------
// OAuth（§7）
// ---------------------------------------------------------------------------

/**
 * POST /2/oauth2/token 的响应（§7.1）。
 *
 * 只有申请了 offline.access scope 才会返回 refresh_token（§7.2），
 * 因此它是必需的——本系统长期无人值守运行，没有 refresh_token 就无法工作。
 */
export const xTokenResponseSchema = strictObject({
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  access_token: z.string().min(1),
  scope: z.string(),
  refresh_token: z.string().min(1),
});

export type XTokenResponse = z.infer<typeof xTokenResponseSchema>;

/**
 * POST /2/oauth2/token（grant_type=refresh_token）的响应（§7.5）。
 *
 * 与授权码换取不同：刷新响应不保证回显 scope，且 refresh_token 会轮换
 * （一次性旧值作废）。X 文档称新 refresh_token 总会返回，但字段仍按可选
 * 校验——缺失时由调用方将账号置为 TOKEN_EXPIRED，而不是在此静默放过。
 */
export const xTokenRefreshResponseSchema = strictObject({
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  access_token: z.string().min(1),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
});

export type XTokenRefreshResponse = z.infer<typeof xTokenRefreshResponseSchema>;

/**
 * OAuth 回调的查询参数。
 *
 * state 必须与发起授权时存入 Redis 的值一致，且一次性用后即删（§7.1）。
 * X 在用户拒绝授权时会带 error 而非 code，两种情况都要能解析。
 */
export const xOAuthCallbackQuerySchema = z.union([
  strictObject({
    code: z.string().min(1),
    state: z.string().min(1),
  }),
  strictObject({
    error: z.string().min(1),
    error_description: z.string().optional(),
    state: z.string().optional(),
  }),
]);

export type XOAuthCallbackQuery = z.infer<typeof xOAuthCallbackQuerySchema>;

/**
 * X API 的 scope 白名单（§7.2）。
 *
 * 必需：tweet.read / users.read / offline.access
 * 明确不申请：tweet.write / like.write / follows.write / dm.write
 *
 * 这是最小权限原则的代码化：若 token 响应里出现写入类 scope，
 * 说明 App 配置有误，应告警而非静默继续（§1.1 单向性声明）。
 */
export const REQUIRED_X_SCOPES = ['tweet.read', 'users.read', 'offline.access'] as const;

/** 出现即代表违反「只读 X」边界的 scope（§1.1、§7.2）。 */
export const FORBIDDEN_X_SCOPES = [
  'tweet.write',
  'like.write',
  'follows.write',
  'dm.write',
  'block.write',
  'mute.write',
  'media.write',
  'accountOffline.read',
] as const;

/** 校验 token 响应的 scope 字符串：必需项齐全，且不含任何写入权限。 */
export function assertXScopes(scopeString: string): void {
  const granted = new Set(scopeString.split(/\s+/).filter(Boolean));

  const missing = REQUIRED_X_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `X OAuth scope 不足，缺少：${missing.join(', ')}。` +
        '请在 X Developer Portal 勾选 tweet.read / users.read / offline.access（§7.2）。',
    );
  }

  const forbidden = FORBIDDEN_X_SCOPES.filter((scope) => granted.has(scope));
  if (forbidden.length > 0) {
    throw new Error(
      `检测到写入类 scope：${forbidden.join(', ')}。` +
        '本系统是只读 X、只写 Binance 的单向管道（§1.1），不应申请任何 X 写入权限。',
    );
  }
}

// ---------------------------------------------------------------------------
// GET /2/usage/tweets（§18.4 / §18.5：成本对账）
// ---------------------------------------------------------------------------

/**
 * Usage endpoint 响应。
 *
 * ⚠️ 待验证（§18.2）：空响应是否绝对不计费、expansions 展开的 media 是否单独计为资源、
 * 翻页时同一 UTC 日内是否稳定去重——这三项官方定价页未明确，需实测。
 * 本 schema 用于每日与本地估算对账，偏差 > 20% 时告警（§18.5）。
 */
export const xUsageResponseSchema = strictObject({
  data: z
    .strictObject({
      daily_usage: z
        .array(
          strictObject({
            date: z.string(),
            usage: z
              .strictObject({ posts: z.number().int().nonnegative() })
              .optional(),
          }),
        )
        .optional(),
      billing_period: z
        .strictObject({
          start_date: z.string().optional(),
          end_date: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type XUsageResponse = z.infer<typeof xUsageResponseSchema>;
