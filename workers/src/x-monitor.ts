/**
 * x-monitor：X 时间线轮询（§6.2~§6.6）。
 *
 * 单次 tick 流程（§6.4）：
 *   取 ACTIVE 账号 → Redis 锁 → 读 last_tweet_id → since_id 拉一页
 *   → Zod 校验（x-client 内做）→ 旧→新排序 → 逐条入库 + 建 DISCOVERED 任务 + 入队
 *   → 同事务推进 last_tweet_id → 更新轮询状态。
 *
 * 关键约束的代码化位置：
 *   - §6.4 帖子写入与 ID 推进同事务 → persistBatch()
 *   - §6.5 baseline → runBaseline()，首次连接绝不回溯历史
 *   - §10.3 连续 3 次 429 → 间隔翻倍并告警
 *   - §7.5 Token 过期前 5 分钟刷新；刷新失败退避 60/300/900s，仍失败置 TOKEN_EXPIRED
 */

import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { JobStatus as PrismaJobStatus, XAccount } from '@prisma/client';
import { prisma, withTransaction } from '@x-square/database';
import {
  acquirePollLock,
  releasePollLock,
} from '@x-square/queue';
import {
  buildIdempotencyKey,
  DEFAULT_POLL_INTERVAL_SEC,
  detectPostType,
  maxSnowflake,
  nextPollIntervalAfterRateLimit,
  POLL_INTERVAL_OPTIONS_SEC,
  POLL_STATUS,
  QUEUE_NAMES,
  sha256Hex,
  sortSnowflakeAsc,
  TOKEN_REFRESH_AHEAD_MS,
  TOKEN_REFRESH_BACKOFF_MS,
  X_ACCOUNT_STATUS,
  type PollIntervalSec,
} from '@x-square/shared';
import { nowIso } from '@x-square/schemas';
import {
  fetchUserTweets,
  refreshAccessToken,
  shouldDoubleInterval,
  XApiError,
  XAuthError,
  XRateLimitError,
  type TransportOptions,
  type UserTweetsResult,
} from '@x-square/x-client';
import type { SyncRules } from '@x-square/schemas';
import type { Queue } from 'bullmq';

import { evaluateSyncRules, type FilterablePost } from './filtering.js';
import { transitionJob } from './state-machine.js';

/** x-monitor 依赖注入面（测试可全部 stub）。 */
export interface MonitorDeps {
  redis: Redis;
  queues: Record<string, Queue>;
  /** 解密 access/refresh token 的函数（密钥由上层从 APP_ENCRYPTION_KEY 派生）。 */
  decryptSecret: (ciphertext: string) => string;
  /** 加密新 token（刷新后整组覆盖旧值，§7.5）。 */
  encryptSecret: (plaintext: string) => string;
  /** OAuth client 凭据（来自环境变量）。 */
  oauth: { clientId: string; clientSecret?: string; redirectUri: string };
  transport?: TransportOptions;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

/** 单账号轮询结果摘要。 */
export interface PollOutcome {
  accountId: string;
  status: string;
  newPosts: number;
  /** 本轮后该账号应使用的轮询间隔秒数。 */
  intervalSec: number;
}

/** 一条已展开媒体信息的 tweet（x-posts 入库前的中间形态）。 */
interface PreparedTweet {
  id: string;
  text: string;
  createdAt: Date;
  conversationId: string | null;
  referencedTweetsJson: unknown;
  editHistoryJson: unknown;
  mediaKeys: string[];
  mediaTypes: string[];
  photoCount: number;
  entitiesJson: unknown;
  rawJson: unknown;
}

/** 把 includes.media 建索引，按 media_key 查。 */
function indexMedia(response: UserTweetsResult['response']): Map<string, { type: string; url?: string }> {
  const map = new Map<string, { type: string; url?: string }>();
  for (const media of response.includes?.media ?? []) {
    map.set(media.media_key, { type: media.type, ...(media.url ? { url: media.url } : {}) });
  }
  return map;
}

/** 将 API 响应转换为待入库行（§8.1 类型判定在此完成）。 */
export function prepareTweets(result: UserTweetsResult): PreparedTweet[] {
  const mediaIndex = indexMedia(result.response);
  return (result.response.data ?? []).map((tweet) => {
    const keys = tweet.attachments?.media_keys ?? [];
    const medias = keys.map((k) => mediaIndex.get(k)).filter((m): m is { type: string; url?: string } => Boolean(m));
    const photoCount = medias.filter((m) => m.type === 'photo').length;
    return {
      id: tweet.id,
      text: tweet.text,
      createdAt: new Date(tweet.created_at),
      conversationId: tweet.conversation_id ?? null,
      referencedTweetsJson: tweet.referenced_tweets ?? null,
      editHistoryJson: tweet.edit_history_tweet_ids ?? null,
      mediaKeys: keys,
      mediaTypes: medias.map((m) => m.type),
      photoCount,
      entitiesJson: tweet.entities ?? null,
      rawJson: tweet,
    };
  });
}

/** 旧→新排序（§6.4：保证发布顺序）。 */
export function sortOldToNew(tweets: PreparedTweet[]): PreparedTweet[] {
  const ids = sortSnowflakeAsc(tweets.map((t) => t.id));
  const byId = new Map(tweets.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * 一批帖子 + last_tweet_id 推进 + sync_job 创建，全部在同一事务（§6.4）。
 *
 * 返回实际新建（非重复）的 job id 列表——只有这些才需要入队。
 */
export async function persistBatch(
  account: Pick<XAccount, 'id' | 'xUserId'>,
  tweets: PreparedTweet[],
  rules: SyncRules,
): Promise<{ enqueued: Array<{ jobId: string; payload: unknown }>; skippedDuplicates: number }> {
  const enqueued: Array<{ jobId: string; payload: unknown }> = [];
  let skippedDuplicates = 0;

  await withTransaction(async (tx) => {
    for (const tweet of tweets) {
      // ON CONFLICT DO NOTHING 语义：先查唯一键（Prisma createMany skipDuplicates 不返回计数）
      const exists = await tx.xPost.findUnique({ where: { xPostId: tweet.id }, select: { id: true } });
      if (exists) {
        skippedDuplicates += 1;
        continue;
      }

      const postType = detectPostType({
        referencedTweets: (tweet.referencedTweetsJson as Array<{ type: string }> | null) ?? [],
        mediaTypes: tweet.mediaTypes.length > 0 ? tweet.mediaTypes : undefined,
      });

      const xPost = await tx.xPost.create({
        data: {
          xPostId: tweet.id,
          xUserId: account.xUserId,
          xAccountId: account.id,
          text: tweet.text,
          postType,
          tweetUrl: `https://x.com/i/web/status/${tweet.id}`,
          conversationId: tweet.conversationId,
          referencedTweetsJson: tweet.referencedTweetsJson as object | undefined,
          editHistoryJson: tweet.editHistoryJson as object | undefined,
          mediaJson: { mediaKeys: tweet.mediaKeys, types: tweet.mediaTypes } as object,
          entitiesJson: tweet.entitiesJson as object | undefined,
          rawJson: tweet.rawJson as object,
          xCreatedAt: tweet.createdAt,
        },
      });

      // 规则评估（§17.5）：FILTERED 终态不建队列任务（§9.1）
      const filterable: FilterablePost = {
        postType,
        text: tweet.text,
        mediaTypes: tweet.mediaTypes,
        photoCount: tweet.photoCount,
      };
      const decision = evaluateSyncRules(filterable, {
        postTypes: rules.postTypes,
        keywords: rules.keywords,
      });

      const contentHash = sha256Hex(`${account.id}:${tweet.id}`);
      const idempotencyKey = buildIdempotencyKey({
        xPostId: tweet.id,
        binanceAccountId: 'pending',
        contentHash,
      });

      const job = await tx.syncJob.create({
        data: {
          xPostId: xPost.id,
          idempotencyKey,
          status: 'DISCOVERED' as PrismaJobStatus,
        },
      });
      await tx.syncJobEvent.create({
        data: { syncJobId: job.id, fromStatus: null, toStatus: 'DISCOVERED' },
      });

      if (!decision.sync) {
        // DISCOVERED → FILTERED 合法转移（§9.1），记录原因供排查（§17.4）
        await tx.syncJob.update({
          where: { id: job.id },
          data: { status: 'FILTERED' as PrismaJobStatus, filterReason: decision.reason },
        });
        await tx.syncJobEvent.create({
          data: {
            syncJobId: job.id,
            fromStatus: 'DISCOVERED',
            toStatus: 'FILTERED',
            detail: { reason: decision.reason },
          },
        });
      } else {
        enqueued.push({
          jobId: job.id,
          payload: {
            syncJobId: job.id,
            xPostId: tweet.id,
            xAccountId: account.id,
            enqueuedAt: nowIso(),
          },
        });
      }
    }

    // 同事务推进断点（§6.4 崩溃安全的核心）
    const maxId = maxSnowflake(tweets.map((t) => t.id));
    if (maxId !== null) {
      await tx.xAccount.update({
        where: { id: account.id },
        data: { lastTweetId: maxId },
      });
    }
  });

  return { enqueued, skippedDuplicates };
}

/** 入队发生在事务提交之后：事务回滚时不会有幽灵任务。 */
async function enqueueDiscovered(deps: MonitorDeps, items: Array<{ jobId: string; payload: unknown }>): Promise<void> {
  for (const item of items) {
    await deps.queues[QUEUE_NAMES.syncPost]!.add('sync', item.payload, {
      jobId: `sync:${item.jobId}`,
    });
  }
}

/** 记录成本估算（§18.5）：每次成功响应的资源数落 api_usage_logs。 */
async function recordUsage(accountId: string, result: UserTweetsResult): Promise<void> {
  const unitCost = 0.001; // Owned Reads 优惠价（§18.1）；App Owner≠认证用户时为 0.005
  await prisma.apiUsageLog.create({
    data: {
      xAccountId: accountId,
      endpoint: 'GET /2/users/:id/tweets',
      resourcesCount: result.resultCount,
      unitCostUsd: unitCost,
      totalCostUsd: result.resultCount * unitCost,
      isOwnedRead: true,
      httpStatus: 200,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Token 临近过期时主动刷新（§7.5）：一次性 refresh_token 必须整组覆盖。 */
export async function ensureFreshToken(deps: MonitorDeps, account: XAccount): Promise<string> {
  const nowMs = deps.now?.() ?? Date.now();
  const refreshToken = deps.decryptSecret(account.refreshTokenEncrypted);
  if (account.tokenExpiresAt.getTime() - nowMs > TOKEN_REFRESH_AHEAD_MS) {
    return deps.decryptSecret(account.accessTokenEncrypted);
  }

  for (let i = 0; ; i += 1) {
    try {
      const fresh = await refreshAccessToken(deps.oauth, refreshToken, deps.transport);
      const expiresAt = new Date(nowMs + fresh.expires_in * 1000);
      await prisma.xAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: deps.encryptSecret(fresh.access_token),
          // 旧 refresh_token 用后即废；缺失时保留原值（上层会因下次仍过期而告警）
          refreshTokenEncrypted: fresh.refresh_token
            ? deps.encryptSecret(fresh.refresh_token)
            : account.refreshTokenEncrypted,
          tokenExpiresAt: expiresAt,
        },
      });
      deps.log('info', 'token refreshed', { accountId: account.id });
      return fresh.access_token;
    } catch (error) {
      const backoff = TOKEN_REFRESH_BACKOFF_MS[i];
      if (backoff === undefined || error instanceof XAuthError) {
        // 退避序列耗尽或 401/403：置 TOKEN_EXPIRED 停止轮询（§7.5）
        await prisma.xAccount.update({
          where: { id: account.id },
          data: { status: X_ACCOUNT_STATUS.tokenExpired, lastPollStatus: POLL_STATUS.authFailed },
        });
        deps.log('error', 'token refresh failed, account marked TOKEN_EXPIRED', {
          accountId: account.id,
        });
        throw error;
      }
      deps.log('warn', `token refresh attempt ${i + 1} failed, backing off`, {
        accountId: account.id,
        backoffMs: backoff,
      });
      await sleep(backoff);
    }
  }
}

/** Token 临近过期时主动刷新（§7.5）：一次性 refresh_token 必须整组覆盖。 */

/** 读取同步规则（settings 表，key=sync_rules）。 */
async function loadRules(): Promise<SyncRules> {
  const row = await prisma.setting.findUnique({ where: { key: 'sync_rules' } });
  const { syncRulesSchema, DEFAULT_SYNC_RULES } = await import('@x-square/schemas');
  if (!row) return DEFAULT_SYNC_RULES;
  const parsed = syncRulesSchema.safeParse(row.value);
  return parsed.success ? parsed.data : DEFAULT_SYNC_RULES;
}

/**
 * 单账号一次轮询（§6.4 全流程）。
 *
 * @returns 处理摘要；拿不到锁时返回 null（另一实例在跑，跳过本轮）
 */
export async function pollAccount(deps: MonitorDeps, account: XAccount): Promise<PollOutcome | null> {
  const lockToken = randomUUID();
  const ttlMs = account.pollIntervalSec * 1000 * 2;
  const locked = await acquirePollLock(deps.redis, account.id, lockToken, ttlMs);
  if (!locked) return null;

  try {
    const accessToken = await ensureFreshToken(deps, account);
    const rules = await loadRules();

    let result: UserTweetsResult;
    try {
      result = await fetchUserTweets(
        { userId: account.xUserId, accessToken, sinceId: account.lastTweetId ?? undefined },
        deps.transport,
      );
    } catch (error) {
      return await handlePollError(deps, account, error);
    }

    await recordUsage(account.id, result);

    const prepared = sortOldToNew(prepareTweets(result));
    const { enqueued } = await persistBatch(
      { id: account.id, xUserId: account.xUserId },
      prepared,
      rules,
    );
    await enqueueDiscovered(deps, enqueued);

    const intervalSec = clampInterval(account.pollIntervalSec);
    await prisma.xAccount.update({
      where: { id: account.id },
      data: {
        lastPollAt: new Date(),
        lastPollStatus:
          result.rateLimitRemaining !== undefined && result.rateLimitRemaining <= 2
            ? POLL_STATUS.rateLimited
            : POLL_STATUS.ok,
        consecutiveFailures: 0,
        pollIntervalSec: intervalSec,
      },
    });

    return { accountId: account.id, status: POLL_STATUS.ok, newPosts: enqueued.length, intervalSec };
  } finally {
    await releasePollLock(deps.redis, account.id, lockToken);
  }
}

/** 轮询错误处置（§6.3 / §10.3）：写 last_poll_status 与连续失败计数。 */
async function handlePollError(
  deps: MonitorDeps,
  account: XAccount,
  error: unknown,
): Promise<PollOutcome> {
  const failures = account.consecutiveFailures + 1;
  let status: string = POLL_STATUS.networkError;
  let intervalSec = clampInterval(account.pollIntervalSec);

  if (error instanceof XRateLimitError) {
    status = POLL_STATUS.rateLimited;
    const doubled = nextPollIntervalAfterRateLimit(
      account.pollIntervalSec,
      failures,
      { maxSec: 300 },
    );
    if (shouldDoubleInterval(failures)) {
      intervalSec = clampInterval(doubled);
      deps.log('warn', 'consecutive 429s, doubling poll interval', {
        accountId: account.id,
        intervalSec,
      });
    }
  } else if (error instanceof XAuthError) {
    status = POLL_STATUS.authFailed;
  } else if (error instanceof XApiError) {
    status = error.httpStatus && error.httpStatus >= 500 ? POLL_STATUS.serverError : POLL_STATUS.networkError;
  }

  await prisma.xAccount.update({
    where: { id: account.id },
    data: {
      lastPollAt: new Date(),
      lastPollStatus: status,
      consecutiveFailures: failures,
      pollIntervalSec: intervalSec,
    },
  });
  deps.log('warn', 'poll failed', { accountId: account.id, status, failures });
  return { accountId: account.id, status, newPosts: 0, intervalSec };
}

function clampInterval(value: number): PollIntervalSec {
  const options: readonly number[] = POLL_INTERVAL_OPTIONS_SEC;
  if ((options as readonly number[]).includes(value)) return value as PollIntervalSec;
  return DEFAULT_POLL_INTERVAL_SEC;
}

/**
 * baseline 执行（§6.5）：首次授权后只记录最新 ID，不回溯任何历史帖。
 *
 * 由 API 层在 OAuth callback 成功后调用。
 */
export async function runBaseline(
  deps: MonitorDeps,
  account: XAccount,
): Promise<string | null> {
  const accessToken = await ensureFreshToken(deps, account);
  const page = await fetchUserTweets(
    { userId: account.xUserId, accessToken, maxResults: 5 },
    deps.transport,
  );
  const ids = (page.response.data ?? []).map((t) => t.id);
  const baseline = maxSnowflake(ids);
  await prisma.xAccount.update({
    where: { id: account.id },
    data: {
      baselineTweetId: baseline,
      lastTweetId: baseline,
      status: X_ACCOUNT_STATUS.active,
    },
  });
  deps.log('info', 'baseline set', { accountId: account.id, baselineTweetId: baseline });
  return baseline;
}
