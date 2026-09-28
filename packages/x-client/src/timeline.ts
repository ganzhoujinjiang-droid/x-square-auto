/**
 * X 时间线轮询客户端（§6.1、§6.5、§6.6）。
 *
 * 唯一数据源：GET /2/users/{id}/tweets。
 * 查询参数严格按 §6.1 声明的字段清单拼装——不多请求、不多校验；
 * X 若新增字段需显式登记到 schemas/x-api.ts，而不是放宽 schema。
 *
 * 本模块不推进 last_tweet_id、不写数据库（§6.4 的事务归 x-monitor Worker）。
 */

import {
  xUserTweetsResponseSchema,
  type XUserTweetsResponse,
} from '@x-square/schemas';
import {
  X_API_BASE_URL,
  X_BASELINE_MAX_RESULTS,
  X_TIMELINE_MAX_RESULTS,
} from '@x-square/shared';

import { XSchemaValidationError } from './errors.js';
import { requestJson, type TransportOptions } from './http.js';

/** §6.1 的字段清单，集中在此处，避免散落字符串。 */
const TIMELINE_QUERY_CONSTANTS = {
  expansions: [
    'attachments.media_keys',
    'referenced_tweets.id',
    'author_id',
    'edit_history_tweet_ids',
  ].join(','),
  tweetFields: [
    'id',
    'text',
    'created_at',
    'author_id',
    'conversation_id',
    'attachments',
    'entities',
    'referenced_tweets',
    'edit_history_tweet_ids',
    'reply_settings',
    'lang',
    'possibly_sensitive',
  ].join(','),
  mediaFields: [
    'media_key',
    'type',
    'url',
    'preview_image_url',
    'width',
    'height',
    'alt_text',
    'duration_ms',
  ].join(','),
  userFields: ['id', 'username'].join(','),
} as const;

/** 一次时间线请求的参数（§6.1）。 */
export interface FetchUserTweetsParams {
  /** 被监控用户的 X user ID（OAuth 后来自 /2/users/me）。 */
  userId: string;
  /** OAuth access token（内存态，绝不落日志，§7.6）。 */
  accessToken: string;
  /** 只返回 ID 大于此值的帖子（核心去重手段）；baseline 场景省略。 */
  sinceId?: string;
  /** 分页 token，仅回溯导入 / 重启补漏时使用（§6.6）。 */
  paginationToken?: string;
  /** max_results，默认 100（V1 固定值）；baseline 用 5（§6.5）。 */
  maxResults?: number;
}

/** 时间线请求结果：校验后的响应 + 计费与状态元数据。 */
export interface UserTweetsResult {
  response: XUserTweetsResponse;
  /** data 长度；空响应返回 0，不产生费用（§18.2）。 */
  resultCount: number;
  /** 响应头速率限制信息（§6.2 / §10.3）。 */
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}

/** 拼装完整 URL（不含凭据，query 中的 ID/token 可安全出现在脱敏日志里）。 */
export function buildTimelineUrl(params: FetchUserTweetsParams): string {
  const url = new URL(`${X_API_BASE_URL}/2/users/${encodeURIComponent(params.userId)}/tweets`);
  url.searchParams.set('max_results', String(params.maxResults ?? X_TIMELINE_MAX_RESULTS));
  if (params.sinceId) url.searchParams.set('since_id', params.sinceId);
  if (params.paginationToken) url.searchParams.set('pagination_token', params.paginationToken);
  url.searchParams.set('expansions', TIMELINE_QUERY_CONSTANTS.expansions);
  url.searchParams.set('tweet.fields', TIMELINE_QUERY_CONSTANTS.tweetFields);
  url.searchParams.set('media.fields', TIMELINE_QUERY_CONSTANTS.mediaFields);
  url.searchParams.set('user.fields', TIMELINE_QUERY_CONSTANTS.userFields);
  return url.toString();
}

/**
 * 拉取一页时间线。
 *
 * 空响应（data 缺失）是合法结果：X 在无新帖时返回 meta.result_count=0，
 * 按 §18.2 不产生费用，这里归一化为空数组而不是报错。
 */
export async function fetchUserTweets(
  params: FetchUserTweetsParams,
  options: TransportOptions = {},
): Promise<UserTweetsResult> {
  const { json, meta } = await requestJson(
    buildTimelineUrl(params),
    { method: 'GET', headers: { Authorization: `Bearer ${params.accessToken}` } },
    options,
  );

  const parsed = xUserTweetsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new XSchemaValidationError(
      'GET /2/users/{id}/tweets',
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }

  const response = parsed.data;
  return {
    response,
    resultCount: response.data?.length ?? 0,
    rateLimitRemaining: meta.rateLimitRemaining,
    rateLimitReset: meta.rateLimitReset,
  };
}

/**
 * baseline 读取（§6.5）：不带 since_id、max_results=5，用于首次连接时
 * 确定「连接之后发布的帖子才算新帖」的起点。调用方取 max ID 写入。
 */
export function fetchBaselinePage(
  userId: string,
  accessToken: string,
  options: TransportOptions = {},
): Promise<UserTweetsResult> {
  return fetchUserTweets(
    { userId, accessToken, maxResults: X_BASELINE_MAX_RESULTS },
    options,
  );
}
