/**
 * image-worker：download-media 与 upload-media（§12）。
 *
 * 流程：X CDN 下载（≤15MB、30s 超时、MIME 白名单）→ 临时文件 →
 * Binance 预签名 PUT → 轮询处理状态（3s × 10 次）→ 全部就绪后入队发布。
 *
 * 硬约束：
 *   - 单图失败最多重试 2 次（MEDIA_MAX_ATTEMPTS，受 400/日 上传配额约束 §11.3）；
 *   - 不允许自动降级为纯文字——图片缺失改变内容语义，必须人工确认（§12）；
 *   - 任务结束（成功或失败）立即删临时文件；进程启动时清空残留目录。
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import type { Queue, Job } from 'bullmq';
import { prisma, withTransaction } from '@x-square/database';
import { reserveQuota } from '@x-square/queue';
import {
  getPresignedUrl,
  getImageStatus,
  uploadToPresignedUrl,
} from '@x-square/binance-client';
import {
  BINANCE_IMAGE_STATUS,
  MEDIA_ALLOWED_MIME_TYPES,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_MAX_ATTEMPTS,
  MEDIA_MAX_BYTES,
  MEDIA_STATUS_POLL_INTERVAL_MS,
  MEDIA_STATUS_POLL_MAX_ATTEMPTS,
  MEDIA_TMP_DIR,
  SYSTEM_ERROR_CODE,
  JOB_STATUS,
  extractExtension,
} from '@x-square/shared';
import { parseQueuePayload, type DownloadMediaPayload, type UploadMediaPayload } from '@x-square/schemas';

import { checkMediaSize } from './filtering.js';
import { transitionJob } from './state-machine.js';
import { queuePublish } from './sync-worker.js';

export interface ImageWorkerDeps {
  redis: Redis;
  queues: Record<string, Queue>;
  decryptSecret: (ciphertext: string) => string;
  fetchImpl?: typeof fetch;
  tmpDir?: string;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
}

/** 进程启动清理：删除上次崩溃残留的媒体临时文件（§12「禁止长期留存」）。 */
export async function cleanupMediaTmp(dir: string = MEDIA_TMP_DIR): Promise<number> {
  let removed = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(dir)) {
      await rm(join(dir, name), { force: true });
      removed += 1;
    }
  } catch {
    // 目录不存在 = 无残留，静默
  }
  return removed;
}

/** download-media 处理器。 */
export async function handleDownloadMedia(deps: ImageWorkerDeps, job: Job): Promise<void> {
  const payload = parseQueuePayload('download-media', job.data) as DownloadMediaPayload;
  if (payload.sourceUrl.length === 0) {
    await failMedia(deps, payload.syncJobId, `媒体 ${payload.mediaKey} 缺少直链`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  let bytes: Buffer;
  try {
    const response = await (deps.fetchImpl ?? globalThis.fetch)(payload.sourceUrl, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!(MEDIA_ALLOWED_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw new Error(`MIME 不在白名单：${contentType || 'unknown'}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if ((job.attemptsMade ?? 0) + 1 >= MEDIA_MAX_ATTEMPTS) {
      await failMedia(deps, payload.syncJobId, `下载失败：${(error as Error).message}`);
    }
    throw error; // BullMQ 退避重试
  } finally {
    clearTimeout(timer);
  }

  const sizeCheck = checkMediaSize(bytes.length);
  if (!sizeCheck.ok) {
    await failMedia(deps, payload.syncJobId, sizeCheck.reason ?? '图片校验未通过');
    return;
  }

  const dir = deps.tmpDir ?? MEDIA_TMP_DIR;
  await mkdir(dir, { recursive: true });
  const ext = extractExtension(payload.sourceUrl) ?? 'jpg';
  const localPath = join(dir, `${payload.syncJobId}-${payload.index}-${createHash('sha1').update(payload.sourceUrl).digest('hex').slice(0, 8)}.${ext}`);
  await writeFile(localPath, bytes);

  const accountRow = await prisma.binanceAccount.findFirst({ where: { status: 'ACTIVE' } });
  if (!accountRow) {
    await failMedia(deps, payload.syncJobId, '未配置可用的 Binance 账号');
    return;
  }

  await deps.queues.uploadMedia!.add(
    'upload',
    {
      syncJobId: payload.syncJobId,
      xPostId: payload.xPostId,
      enqueuedAt: new Date().toISOString(),
      localPath,
      fileName: `${payload.mediaKey}.${ext}`,
      index: payload.index,
      binanceAccountId: accountRow.id,
    } satisfies UploadMediaPayload,
    { jobId: `ul:${payload.syncJobId}:${payload.mediaKey}` },
  );
}

/** upload-media 处理器：预签名 PUT + 轮询状态 + 汇总触发发布。 */
export async function handleUploadMedia(deps: ImageWorkerDeps, job: Job): Promise<void> {
  const payload = parseQueuePayload('upload-media', job.data) as UploadMediaPayload;
  const account = await prisma.binanceAccount.findUniqueOrThrow({
    where: { id: payload.binanceAccountId },
  });
  const apiKey = deps.decryptSecret(account.apiKeyEncrypted);
  const transport = { apiKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };

  // 上传也计入 400/日 配额（§11.3）：先预占再传
  const quota = await reserveQuota(deps.redis, payload.binanceAccountId, 'upload_count');
  if (!quota.allowed) {
    await failMedia(deps, payload.syncJobId, `今日 ${quota.limit} 次上传已达上限`);
    return;
  }

  let imageUrl: string;
  try {
    const presigned = await getPresignedUrl(payload.fileName, transport);
    const data = await readFileSafe(payload.localPath);
    if (data === null) {
      await failMedia(deps, payload.syncJobId, '临时文件丢失，请重新入队');
      return;
    }
    await uploadToPresignedUrl(presigned.presignedUrl, data, payload.fileName, transport);
    imageUrl = await pollImageStatus(transport, presigned.fileTicket, deps.log);
  } catch (error) {
    if ((job.attemptsMade ?? 0) + 1 >= MEDIA_MAX_ATTEMPTS) {
      await failMedia(deps, payload.syncJobId, `上传失败：${(error as Error).message}`);
    }
    throw error;
  } finally {
    // 无论成败都清临时文件（§12）
    await rm(payload.localPath, { force: true }).catch(() => undefined);
  }

  // 结果按 index 暂存到 SyncJobEvent detail（media_snapshot），全部到齐后统一发布
  await withTransaction(async (tx) => {
    await tx.syncJobEvent.create({
      data: {
        syncJobId: payload.syncJobId,
        fromStatus: JOB_STATUS.mediaProcessing,
        toStatus: JOB_STATUS.mediaProcessing,
        detail: { mediaUploaded: { index: payload.index, imageUrl } },
      },
    });
  });

  // 汇总该任务已完成的图片数，达到预期即触发发布
  const expected = await countExpectedImages(payload.syncJobId);
  const done = await collectUploadedImages(payload.syncJobId);
  if (done.size >= expected) {
    const ordered = [...Array(expected).keys()].map((i) => done.get(i)).filter((u): u is string => Boolean(u));
    const snapshot = await prisma.syncJob.findUniqueOrThrow({
      where: { id: payload.syncJobId },
      select: { contentSnapshot: true },
    });
    await queuePublish(deps, payload.syncJobId, snapshot.contentSnapshot ?? '', ordered);
  }
}

async function pollImageStatus(
  transport: { apiKey: string; fetchImpl?: typeof fetch },
  fileTicket: string,
  log: ImageWorkerDeps['log'],
): Promise<string> {
  for (let attempt = 0; attempt < MEDIA_STATUS_POLL_MAX_ATTEMPTS; attempt += 1) {
    const data = await getImageStatus(fileTicket, transport);
    if (data.status === BINANCE_IMAGE_STATUS.ready && data.imageUrl) return data.imageUrl;
    if (data.status === BINANCE_IMAGE_STATUS.failed) {
      throw new Error(`图片处理失败：${data.failedReason ?? '原因未知'}`);
    }
    await sleep(MEDIA_STATUS_POLL_INTERVAL_MS);
  }
  throw new Error('图片处理轮询超时（30s），按可重试处理');
}

/** 从 x_posts.media_json.keys 得到应有图片数。 */
async function countExpectedImages(syncJobId: string): Promise<number> {
  const row = await prisma.syncJob.findUniqueOrThrow({
    where: { id: syncJobId },
    include: { xPost: { select: { mediaJson: true } } },
  });
  const keys = (row.xPost.mediaJson as { keys?: string[] } | null)?.keys ?? [];
  return keys.filter((k) => k !== undefined).length;
}

/** 读取已完成上传的 index→url 映射。 */
async function collectUploadedImages(syncJobId: string): Promise<Map<number, string>> {
  const events = await prisma.syncJobEvent.findMany({
    where: { syncJobId, toStatus: JOB_STATUS.mediaProcessing },
    orderBy: { createdAt: 'asc' },
  });
  const map = new Map<number, string>();
  for (const event of events) {
    const detail = event.detail as { mediaUploaded?: { index: number; imageUrl: string } } | null;
    if (detail?.mediaUploaded) map.set(detail.mediaUploaded.index, detail.mediaUploaded.imageUrl);
  }
  return map;
}

/** 图片链路失败 → FAILED + 人工三选一（§12），绝不自动降级纯文字。 */
async function failMedia(deps: ImageWorkerDeps, syncJobId: string, reason: string): Promise<void> {
  const status = await prisma.syncJob.findUnique({ where: { id: syncJobId }, select: { status: true } });
  if (!status || status.status === JOB_STATUS.failed) return;
  await transitionJob(syncJobId, JOB_STATUS.failed, {
    errorCode: SYSTEM_ERROR_CODE.mediaProcessingFailed,
    errorMessage: reason,
  });
  deps.log('warn', 'media processing failed, awaiting manual decision', { syncJobId, reason });
}

async function readFileSafe(path: string): Promise<Buffer | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
