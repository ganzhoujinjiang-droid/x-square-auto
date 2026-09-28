/**
 * worker 进程入口：单进程内启动全部 worker（§5、§16.2）。
 *
 * x-monitor 用自调度 setTimeout（间隔来自各账号 pollIntervalSec），
 * 其余队列用 BullMQ Worker。§10.1 的参数在此统一应用：
 *   lockDuration 60s（publish 120s）、stalledInterval 30s。
 */

import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUE_NAMES, QUEUE_PUBLISH_LOCK_DURATION_MS } from '@x-square/shared';
import { QUEUE_SETTINGS } from '@x-square/queue';
import { prisma, disconnectPrisma } from '@x-square/database';

import { pollAccount, type MonitorDeps } from './x-monitor.js';
import { cleanupMediaTmp } from './image-worker.js';

// 后台 API 复用人工转移与规则引擎（§9.2 / §17.5）
export { transitionJob, manualTransition, getJobStatus } from './state-machine.js';
export { evaluateSyncRules, checkMediaSize } from './filtering.js';
import {
  handleProcessContent,
  handlePublishBinance,
  handleSyncPost,
  type SyncWorkerDeps,
} from './sync-worker.js';
import { handleDownloadMedia, handleUploadMedia, type ImageWorkerDeps } from './image-worker.js';

export interface BootstrapConfig extends Omit<MonitorDeps, 'queues' | 'redis'> {
  connection: ConnectionOptions;
  redis: MonitorDeps['redis'];
  queues: MonitorDeps['queues'];
}

/** 创建并启动全部组件；返回句柄供优雅退出。 */
export function startWorkers(config: BootstrapConfig) {
  const deps: SyncWorkerDeps & ImageWorkerDeps = config;

  const workers = [
    new Worker(QUEUE_NAMES.syncPost, (job) => handleSyncPost(deps, job), {
      connection: config.connection,
      lockDuration: QUEUE_SETTINGS.lockDurationMs,
      stalledInterval: QUEUE_SETTINGS.stalledIntervalMs,
    }),
    new Worker(QUEUE_NAMES.processContent, (job) => handleProcessContent(deps, job), {
      connection: config.connection,
      lockDuration: QUEUE_SETTINGS.lockDurationMs,
      stalledInterval: QUEUE_SETTINGS.stalledIntervalMs,
    }),
    new Worker(QUEUE_NAMES.downloadMedia, (job) => handleDownloadMedia(deps, job), {
      connection: config.connection,
      lockDuration: QUEUE_SETTINGS.lockDurationMs,
      stalledInterval: QUEUE_SETTINGS.stalledIntervalMs,
    }),
    new Worker(QUEUE_NAMES.uploadMedia, (job) => handleUploadMedia(deps, job), {
      connection: config.connection,
      lockDuration: QUEUE_SETTINGS.lockDurationMs,
      stalledInterval: QUEUE_SETTINGS.stalledIntervalMs,
    }),
    // §10.1：发布链路任务锁更长
    new Worker(QUEUE_NAMES.publishBinance, (job) => handlePublishBinance(deps, job), {
      connection: config.connection,
      lockDuration: QUEUE_PUBLISH_LOCK_DURATION_MS,
      stalledInterval: QUEUE_SETTINGS.stalledIntervalMs,
    }),
  ];

  // x-monitor 轮询循环：每 tick 取 ACTIVE 账号按各自间隔调度
  let stopped = false;
  const timers = new Map<string, NodeJS.Timeout>();

  async function scheduleTick(): Promise<void> {
    if (stopped) return;
    const accounts = await prisma.xAccount.findMany({
      where: { status: 'ACTIVE', monitoringEnabled: true },
    });
    for (const account of accounts) {
      if (timers.has(account.id)) continue; // 该账号已有在途调度
      const fire = async () => {
        timers.delete(account.id);
        try {
          const fresh = await prisma.xAccount.findUnique({ where: { id: account.id } });
          if (fresh && fresh.status === 'ACTIVE' && fresh.monitoringEnabled) {
            await pollAccount(config, fresh);
          }
        } catch (error) {
          config.log('error', 'poll tick crashed', { accountId: account.id, error: String(error) });
        } finally {
          const current = await prisma.xAccount.findUnique({
            where: { id: account.id },
            select: { pollIntervalSec: true },
          });
          const nextMs = (current?.pollIntervalSec ?? account.pollIntervalSec) * 1000;
          if (!stopped) {
            timers.set(account.id, setTimeout(fire, nextMs));
          }
        }
      };
      timers.set(account.id, setTimeout(fire, account.pollIntervalSec * 1000));
    }
  }

  void cleanupMediaTmp().then((n: number) => {
    if (n > 0) config.log('info', `media tmp cleaned: ${n}`);
  });
  void scheduleTick();
  const heartbeat = setInterval(() => void scheduleTick(), 5_000);

  return {
    async close(): Promise<void> {
      stopped = true;
      clearInterval(heartbeat);
      for (const timer of timers.values()) clearTimeout(timer);
      await Promise.all(workers.map((w) => w.close()));
      await disconnectPrisma();
    },
  };
}
