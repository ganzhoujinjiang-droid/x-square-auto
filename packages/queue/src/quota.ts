/**
 * Binance 日配额计数器（§11.3）。
 *
 * 按 UTC 日滚动（键含 yyyymmdd，TTL 48h），发帖/上传前必须先过这里：
 *   - 发帖达 100 / 上传达 400 → 拒绝入队并标记 FAILED（DAILY_POST_LIMIT / DAILY_UPLOAD_LIMIT），
 *     「不要发出去等 220009」（§11.3）；
 *   - 达预警阈值（95 / 380）→ 后台黄色提示。
 *
 * INCR 是原子的，多 Worker 并发计数不会互相吞掉。
 */

import type { Redis } from 'ioredis';
import {
  BINANCE_COUNTER_TTL_MS,
  BINANCE_DAILY_POST_LIMIT,
  BINANCE_DAILY_POST_WARN_AT,
  BINANCE_DAILY_UPLOAD_LIMIT,
  BINANCE_DAILY_UPLOAD_WARN_AT,
  binanceQuotaKey,
} from '@x-square/shared';

export type QuotaKind = 'post_count' | 'upload_count';

/** 配额检查结果。 */
export interface QuotaCheck {
  /** 是否允许继续（未达硬限额）。 */
  allowed: boolean;
  /** 当前已用量（本次检查时的值，不含预占）。 */
  used: number;
  limit: number;
  /** 是否已达预警阈值。 */
  warn: boolean;
}

function limitsFor(kind: QuotaKind): { limit: number; warnAt: number } {
  return kind === 'post_count'
    ? { limit: BINANCE_DAILY_POST_LIMIT, warnAt: BINANCE_DAILY_POST_WARN_AT }
    : { limit: BINANCE_DAILY_UPLOAD_LIMIT, warnAt: BINANCE_DAILY_UPLOAD_WARN_AT };
}

/** 只读检查（不计数），用于 UI 展示与入队前判断。 */
export async function checkQuota(
  redis: Redis,
  accountId: string,
  kind: QuotaKind,
  now: Date = new Date(),
): Promise<QuotaCheck> {
  const { limit, warnAt } = limitsFor(kind);
  const raw = await redis.get(binanceQuotaKey(accountId, kind, now));
  const used = raw === null ? 0 : Number(raw);
  return { allowed: used < limit, used, limit, warn: used >= warnAt };
}

/**
 * 预占一次配额（INCR + EXPIRE）。
 *
 * 返回 false 表示已达硬限额、调用方不得发起请求。注意：预占后若请求最终失败，
 * 由调用方决定是否回退——图片上传失败也计入 400 配额（§11.3），因此不做自动回退。
 */
export async function reserveQuota(
  redis: Redis,
  accountId: string,
  kind: QuotaKind,
  now: Date = new Date(),
): Promise<QuotaCheck> {
  const key = binanceQuotaKey(accountId, kind, now);
  // INCR 原子；随后设置 TTL。两步之间崩溃只会留下无 TTL 的键，
  // 由进程启动清理逻辑兜底（§12 临时文件同理），不影响计数正确性。
  const count = await redis.incr(key);
  await redis.pexpire(key, BINANCE_COUNTER_TTL_MS);
  const { limit, warnAt } = limitsFor(kind);
  return { allowed: count <= limit, used: count, limit, warn: count >= warnAt };
}
