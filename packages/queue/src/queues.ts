/**
 * BullMQ 队列定义（§10.1）。
 *
 * 6 条队列全部在此集中声明，参数与 shared/constants 一一对应：
 *   attempts 5 / custom backoff 30s→600s / lockDuration 60s（publish 120s）
 *   stalledInterval 30s / removeOnComplete 1000 / removeOnFail false
 *
 * removeOnFail=false 是硬约束（§10.1）：失败任务必须保留供排查。
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import {
  QUEUE_ATTEMPTS,
  QUEUE_BACKOFF_DELAYS_MS,
  QUEUE_LOCK_DURATION_MS,
  QUEUE_NAMES,
  QUEUE_PUBLISH_LOCK_DURATION_MS,
  QUEUE_REMOVE_ON_COMPLETE_COUNT,
  QUEUE_REMOVE_ON_FAIL,
  QUEUE_STALLED_INTERVAL_MS,
  computeBackoffDelay,
} from '@x-square/shared';

/** §10.1 的通用重试参数。 */
const defaultJobOptions = {
  attempts: QUEUE_ATTEMPTS,
  backoff: { type: 'custom' as const },
  removeOnComplete: { count: QUEUE_REMOVE_ON_COMPLETE_COUNT },
  removeOnFail: QUEUE_REMOVE_ON_FAIL,
};

/** BullMQ custom backoff 回调：按 attempt 取 30/60/120/300/600s（§10.1）。 */
export function customBackoffDelay(attempt: number): number {
  return computeBackoffDelay(attempt);
}

/**
 * 队列级默认设置（Queue 构造时保存，Worker 未显式覆盖时继承）。
 *
 * ⚠️ bullmq 5.x 中 lockDuration / stalledInterval 属于 WorkerOptions；
 * Queue 侧 settings 仅承载 repeat 相关配置。本系统通过该导出对象把
 * §10.1 的参数集中管理，createWorker（workers/index.ts）统一应用。
 */
export const QUEUE_SETTINGS = {
  /** 默认任务锁时长；publish-binance 用 QUEUE_PUBLISH_LOCK_DURATION_MS */
  lockDurationMs: QUEUE_LOCK_DURATION_MS,
  publishLockDurationMs: QUEUE_PUBLISH_LOCK_DURATION_MS,
  stalledIntervalMs: QUEUE_STALLED_INTERVAL_MS,
} as const;

/** 创建一条队列。 */
export function createQueue(
  name: (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
  connection: ConnectionOptions,
): Queue {
  return new Queue(name, { connection, defaultJobOptions });
}

/** 一次性创建全部 V1 队列（reconcile-uncertain 属 V2，默认不建）。 */
export function createAllQueues(connection: ConnectionOptions): Record<string, Queue> {
  return {
    [QUEUE_NAMES.syncPost]: createQueue(QUEUE_NAMES.syncPost, connection),
    [QUEUE_NAMES.processContent]: createQueue(QUEUE_NAMES.processContent, connection),
    [QUEUE_NAMES.downloadMedia]: createQueue(QUEUE_NAMES.downloadMedia, connection),
    [QUEUE_NAMES.uploadMedia]: createQueue(QUEUE_NAMES.uploadMedia, connection),
    [QUEUE_NAMES.publishBinance]: createQueue(QUEUE_NAMES.publishBinance, connection),
  };
}

/** 退避序列导出给 Worker 做「是否已到最后一次尝试」判断。 */
export const BACKOFF_DELAYS_MS = QUEUE_BACKOFF_DELAYS_MS;
