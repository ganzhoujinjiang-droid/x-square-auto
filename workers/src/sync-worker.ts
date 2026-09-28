/**
 * sync-worker：sync-post / process-content / publish-binance 三个处理器（§10.1）。
 *
 * §10.4 崩溃恢复的第一条铁律在每个处理器开头执行：
 *   「读取并校验当前 job 状态」——若已是终态或 UNCERTAIN/SUCCESS，立即终止。
 */

import type { Redis } from 'ioredis';
import type { Queue, Job } from 'bullmq';
import { prisma, withTransaction } from '@x-square/database';
import { checkQuota, reserveQuota } from '@x-square/queue';
import { renderTemplate, SYSTEM_ERROR_CODE, truncateForLog } from '@x-square/shared';
import { JOB_STATUS, dispositionToStatus, type FailureDisposition } from '@x-square/shared';
import { DEFAULT_SYNC_RULES, parseQueuePayload, SETTING_KEYS, syncRulesSchema } from '@x-square/schemas';
import type { SyncPostPayload, ProcessContentPayload, PublishBinancePayload } from '@x-square/schemas';
import { publishShortPost, type BinanceApiError } from '@x-square/binance-client';

import { evaluateSyncRules, type FilterablePost } from './filtering.js';
import { transitionJob } from './state-machine.js';

export interface SyncWorkerDeps {
  redis: Redis;
  queues: Record<string, Queue>;
  decryptSecret: (ciphertext: string) => string;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
}

/** 从 settings 表加载规则，缺省回退默认值。 */
async function loadRules() {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.syncRules } });
  if (!row) return DEFAULT_SYNC_RULES;
  const parsed = syncRulesSchema.safeParse(row.value);
  return parsed.success ? parsed.data : DEFAULT_SYNC_RULES;
}

/**
 * sync-post 处理器（§6.4 入队后的第一步）。
 *
 * 载荷解析失败 → FAILED + 不重试（§10.2 Zod 校验类错误）。
 */
export async function handleSyncPost(deps: SyncWorkerDeps, job: Job): Promise<void> {
  const payload = parseQueuePayload('sync-post', job.data) as SyncPostPayload;
  const status = await readStatus(payload.syncJobId);
  if (status === null || isSettled(status)) return; // §10.4

  // DISCOVERED → QUEUED 的评估在入库事务里已经做过（x-monitor.persistBatch），
  // 这里只做二次确认与幂等推进；重复投递时直接跳过。
  if (status !== JOB_STATUS.discovered) return;

  const rules = await loadRules();
  const record = await prisma.syncJob.findUniqueOrThrow({
    where: { id: payload.syncJobId },
    include: { xPost: true },
  });

  const filterable: FilterablePost = {
    postType: record.xPost.postType as FilterablePost['postType'],
    text: record.xPost.text,
    mediaTypes: ((record.xPost.mediaJson as { types?: string[] } | null)?.types) ?? [],
    photoCount: ((record.xPost.mediaJson as { keys?: string[] } | null)?.keys ?? []).length,
  };
  // §17.5 总开关关闭时新帖仍入库但一律 FILTERED
  const decision = rules.enabled
    ? evaluateSyncRules(filterable, rules)
    : ({ sync: false, reason: '自动同步总开关已关闭' } as const);

  if (!decision.sync) {
    await transitionJob(payload.syncJobId, JOB_STATUS.filtered, { filterReason: decision.reason });
    deps.log('info', 'job filtered', { jobId: payload.syncJobId, reason: decision.reason });
    return;
  }

  await transitionJob(payload.syncJobId, JOB_STATUS.queued);
  await deps.queues.processContent!.add(
    'process',
    {
      syncJobId: payload.syncJobId,
      xPostId: payload.xPostId,
      enqueuedAt: new Date().toISOString(),
      textMode: rules.textMode,
    } satisfies ProcessContentPayload,
    { jobId: `content:${payload.syncJobId}` },
  );
}

/**
 * process-content 处理器（§14）：原样 / 模板化渲染正文，产出 content_snapshot。
 *
 * AI 模式在 V1 关闭；若配置开启但 ai 包无 Provider，降级原样并记 warning（§15.2）。
 */
export async function handleProcessContent(deps: SyncWorkerDeps, job: Job): Promise<void> {
  const payload = parseQueuePayload('process-content', job.data) as ProcessContentPayload;
  const status = await readStatus(payload.syncJobId);
  if (status === null || isSettled(status)) return;

  const rules = await loadRules();
  const record = await prisma.syncJob.findUniqueOrThrow({
    where: { id: payload.syncJobId },
    include: { xPost: { include: { xAccount: true } } },
  });

  let bodyTextOnly: string;
  if (payload.textMode === 'template') {
    bodyTextOnly = renderTemplate(rules.template, {
      text: record.xPost.text,
      url: rules.keepSourceLink ? record.xPost.tweetUrl : '',
      username: record.xPost.xAccount.username,
      date: record.xPost.xCreatedAt.toISOString().slice(0, 10),
      hashtags: rules.hashtags,
    });
  } else {
    // raw 与 ai-未启用 都走原样（§14.2：逐字节不变，$BTC/#topic 不转义）
    bodyTextOnly = record.xPost.text;
    if (payload.textMode === 'ai') {
      deps.log('warn', 'AI mode requested but provider not wired, fallback to raw', {
        jobId: payload.syncJobId,
      });
    }
  }

  if (bodyTextOnly.trim() === '') {
    await transitionJob(payload.syncJobId, JOB_STATUS.failed, {
      errorCode: 'EMPTY_CONTENT',
      errorMessage: '处理后正文为空，检查过滤规则',
    });
    return;
  }

  await withTransaction(async (tx) => {
    await tx.syncJob.update({
      where: { id: payload.syncJobId },
      data: { contentSnapshot: bodyTextOnly },
    });
  });

  // 有图片 → MEDIA_PROCESSING 链路（§12）；纯文本直接发布
  const mediaKeys = ((record.xPost.mediaJson as { keys?: string[] } | null)?.keys) ?? [];
  const medias = ((record.xPost.rawJson as { attachments?: { media_keys?: string[] } } | null)?.attachments?.media_keys) ?? [];
  if (medias.length > 0) {
    await transitionJob(payload.syncJobId, JOB_STATUS.mediaProcessing);
    for (const [index, mediaKey] of medias.entries()) {
      await deps.queues.downloadMedia!.add(
        'download',
        {
          syncJobId: payload.syncJobId,
          xPostId: payload.xPostId,
          enqueuedAt: new Date().toISOString(),
          sourceUrl: resolvePhotoUrl(record.xPost.rawJson, mediaKey) ?? '',
          mediaKey,
          index,
        },
        { jobId: `dl:${payload.syncJobId}:${mediaKey}` },
      );
    }
    return;
  }

  await queuePublish(deps, payload.syncJobId, bodyTextOnly, []);
}

/** 从 raw_json.includes 之外的展开不可得，photo URL 由 x-monitor 随 mediaJson 存。 */
function resolvePhotoUrl(rawJson: unknown, mediaKey: string): string | null {
  const includes = (rawJson as { __mediaUrls?: Record<string, string> })?.__mediaUrls;
  return includes?.[mediaKey] ?? null;
}

/** 发布入队（publish-binance 前置配额检查在处理器内做，§11.3）。 */
export async function queuePublish(
  deps: SyncWorkerDeps,
  syncJobId: string,
  bodyTextOnly: string,
  imageList: string[],
): Promise<void> {
  const job = await prisma.syncJob.findUniqueOrThrow({
    where: { id: syncJobId },
    select: {
      idempotencyKey: true,
      status: true,
      xPost: { select: { xPostId: true } },
    },
  });
  const accountRow = await prisma.binanceAccount.findFirst({ where: { status: 'ACTIVE' } });
  if (!accountRow) {
    await transitionJob(syncJobId, JOB_STATUS.failed, {
      errorCode: 'NO_BINANCE_ACCOUNT',
      errorMessage: '未配置可用的 Binance 账号',
    });
    return;
  }

  // 纯文本链路：QUEUED → PROCESSING → PUBLISHING（§9.1）；媒体链路的 PROCESSING 已发生
  if (job.status === JOB_STATUS.queued) {
    await transitionJob(syncJobId, JOB_STATUS.processing);
  }
  await transitionJob(syncJobId, JOB_STATUS.publishing);

  await deps.queues.publishBinance!.add(
    'publish',
    {
      syncJobId,
      xPostId: job.xPost.xPostId,
      binanceAccountId: accountRow.id,
      idempotencyKey: job.idempotencyKey,
      bodyTextOnly,
      ...(imageList.length > 0 ? { imageList } : {}),
      allowUncertain: true,
      enqueuedAt: new Date().toISOString(),
    } satisfies PublishBinancePayload,
    { jobId: `pub:${syncJobId}` },
  );
}

/**
 * publish-binance 处理器（危险区，§9.1）。
 *
 * 顺序固定：读状态 → 查幂等键是否已 SUCCESS → 配额预占 → 发请求 → 按处置落状态。
 * 任何 uncertain 都不重发（§28 第五句）。
 */
export async function handlePublishBinance(deps: SyncWorkerDeps, job: Job): Promise<void> {
  const payload = parseQueuePayload('publish-binance', job.data) as PublishBinancePayload;
  const status = await readStatus(payload.syncJobId);
  if (status === null) return;
  if (isPublishSettled(status)) {
    // §10.4：stalled 重新分配后绝不能重复调用 Binance
    deps.log('warn', 'publish job re-delivered after settled, skip', { jobId: payload.syncJobId, status });
    return;
  }

  // §9.4 第二道防线：幂等键已有 SUCCESS 记录则跳过
  const existingSuccess = await prisma.binancePost.findFirst({
    where: { syncJob: { idempotencyKey: payload.idempotencyKey }, status: 'SUCCESS' },
  });
  if (existingSuccess) {
    await transitionJob(payload.syncJobId, JOB_STATUS.success);
    return;
  }

  const quota = await reserveQuota(deps.redis, payload.binanceAccountId, 'post_count');
  if (!quota.allowed) {
    await transitionJob(payload.syncJobId, JOB_STATUS.failed, {
      errorCode: SYSTEM_ERROR_CODE.dailyPostLimit,
      errorMessage: `今日 ${quota.limit} 帖已达上限，UTC 0 点后自动恢复`,
    });
    return;
  }

  const account = await prisma.binanceAccount.findUniqueOrThrow({
    where: { id: payload.binanceAccountId },
  });
  const apiKey = deps.decryptSecret(account.apiKeyEncrypted);

  try {
    const result = await publishShortPost(
      {
        contentType: 1,
        bodyTextOnly: payload.bodyTextOnly,
        ...(payload.imageList && payload.imageList.length > 0 ? { imageList: payload.imageList } : {}),
      },
      { apiKey },
    );

    await withTransaction(async (tx) => {
      await tx.binancePost.create({
        data: {
          syncJobId: payload.syncJobId,
          xPostId: payload.xPostId,
          binanceAccountId: payload.binanceAccountId,
          binancePostId: result.postId,
          binancePostUrl: result.postUrl,
          contentSnapshot: payload.bodyTextOnly,
          mediaSnapshot: payload.imageList ?? undefined,
          status: 'SUCCESS',
          publishedAt: new Date(),
        },
      });
    });

    if (result.outcome === 'published_with_id') {
      await transitionJob(payload.syncJobId, JOB_STATUS.success);
    } else {
      // 官方 skill 把「成功但无 ID」当成功；本系统保守转人工确认（§9.3 决策记录）
      await transitionJob(payload.syncJobId, JOB_STATUS.uncertain, {
        uncertainReason: 'HTTP_504',
        errorMessage: '发布可能成功但未返回帖子 ID，请人工核对',
      });
    }
  } catch (error) {
    const apiError = error as BinanceApiError;
    const disposition: FailureDisposition | undefined = apiError.disposition;
    if (!disposition) throw error;
    const target = dispositionToStatus(disposition);
    if (target === null) {
      // retry：保持 PUBLISHING，交给 BullMQ 退避重试
      throw error;
    }
    await transitionJob(payload.syncJobId, target, {
      errorCode: apiError.binanceCode ?? String(apiError.httpStatus ?? 'UNKNOWN'),
      errorMessage: truncateForLog(disposition.reason, 500),
      ...(target === JOB_STATUS.uncertain ? { uncertainReason: classifyUncertainReason(apiError) } : {}),
    });
    deps.log('error', 'publish failed', { jobId: payload.syncJobId, kind: disposition.kind });
  }
}

function classifyUncertainReason(error: BinanceApiError): string {
  if (error.httpStatus === 504) return 'HTTP_504';
  if (error.message.includes('超时')) return 'TIMEOUT';
  return 'CONNECTION_RESET';
}

async function readStatus(syncJobId: string): Promise<string | null> {
  const row = await prisma.syncJob.findUnique({ where: { id: syncJobId }, select: { status: true } });
  return row?.status ?? null;
}

function isSettled(status: string): boolean {
  return (
    status === JOB_STATUS.success ||
    status === JOB_STATUS.failed ||
    status === JOB_STATUS.uncertain ||
    status === JOB_STATUS.cancelled ||
    status === JOB_STATUS.filtered
  );
}

function isPublishSettled(status: string): boolean {
  return status === JOB_STATUS.success || status === JOB_STATUS.uncertain;
}
