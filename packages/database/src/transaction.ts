/**
 * 事务封装（§6.4、§7.5、§10.4）。
 *
 * 本系统有三处必须保证原子性的写入，任何一处拆开都会造成不可恢复的数据错误：
 *
 *   1. §6.4  帖子入库 + last_tweet_id 推进必须同事务提交。
 *            拆开则崩溃时丢帖（ID 已推进但帖子没写入）或重复（帖子写入但 ID 没推进）。
 *
 *   2. §7.5  Token 刷新必须同事务覆盖旧值。
 *            X 的 refresh_token 是一次性的，并发刷新会导致 Token 永久失效。
 *
 *   3. §9.2  状态转移 + SyncJobEvent 审计记录必须同事务。
 *            拆开则详情页的「完整任务历史」会出现缺失或与实际状态矛盾的记录。
 */

import { Prisma } from '@prisma/client';

import { prisma, type PrismaTransactionClient } from './client.js';

/** 交互式事务的默认配置。 */
const DEFAULT_TRANSACTION_OPTIONS = {
  /** 单事务最长执行时间。轮询批处理可能涉及 100 条帖子，给足余量。 */
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const;

/**
 * 在交互式事务中执行一组写操作。
 *
 * 用法（§6.4 的原子推进）：
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   await tx.xPost.createMany({ data: posts, skipDuplicates: true });
 *   await tx.xAccount.update({
 *     where: { id: accountId },
 *     data: { lastTweetId: maxId },
 *   });
 * });
 * ```
 *
 * 抛出任何错误都会回滚，包括 Zod 校验失败与业务规则违规——
 * 因此校验应放在事务外，事务体内只做写入，缩短持锁时间。
 *
 * @param options 覆盖默认的 maxWait / timeout / isolationLevel
 */
export async function withTransaction<T>(
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  return prisma.$transaction(fn, {
    ...DEFAULT_TRANSACTION_OPTIONS,
    ...options,
  });
}

/** 判定错误是否可重试的函数签名。 */
export type RetryablePredicate = (error: unknown) => boolean;

/** 重试策略配置。 */
export interface RetryOptions {
  /** 最大尝试次数，默认 3。 */
  maxAttempts?: number;
  /** 可重试判定，默认使用 PostgreSQL 串行化冲突判定。 */
  isRetryable?: RetryablePredicate;
  /** 第 attempt 次失败后的退避毫秒数，默认线性退避（attempt × 50ms）。 */
  backoffMs?: (attempt: number) => number;
}

/**
 * 通用重试执行器：仅对「可重试」的错误重试，其余立即抛出。
 *
 * 抽成独立函数的原因：重试分类是 §10.2 的核心保守原则（盲目重试会掩盖真实的业务失败），
 * 但它不应该要求数据库连接才能被验证。withTransactionRetry 只是把它接到 Prisma 事务上。
 *
 * @param operation 被重试的操作，无参数——调用方自行闭包捕获事务客户端
 */
export async function retryOnTransientError<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const isRetryable = options.isRetryable ?? isRetryableTransactionError;
  const backoffMs = options.backoffMs ?? ((attempt: number) => attempt * 50);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // 不可重试，或已达上限：原样抛出，不吞异常也不替换错误类型
      if (!isRetryable(error) || attempt >= maxAttempts) {
        throw error;
      }
      // 线性退避，避免多实例同步重试再次撞车
      await sleep(backoffMs(attempt));
    }
  }
}

/**
 * 带重试的事务执行。
 *
 * 仅对 PostgreSQL 的串行化冲突与死锁重试（SQLSTATE 40001 / 40P01）。
 * 其他错误立即抛出——盲目重试会掩盖真实的业务失败（§10.2 的保守原则）。
 *
 * §6.4 要求每账号加 Redis 分布式锁，因此冲突本应罕见；这里只是兜底，
 * 不替代分布式锁。
 */
export async function withTransactionRetry<T>(
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options: { maxAttempts?: number; maxWait?: number; timeout?: number } = {},
): Promise<T> {
  return retryOnTransientError(
    () =>
      withTransaction(fn, {
        ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      }),
    { ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}) },
  );
}

/**
 * 判断错误是否为可重试的串行化冲突 / 死锁。
 *
 * P2034 是 Prisma 对「因写冲突或死锁导致事务失败」的专用码，官方建议重试；
 * 同时兼容直接透出 PostgreSQL SQLSTATE 的情况（40001 串行化失败、40P01 死锁）。
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return true;
    }
    const meta = error.meta as { code?: string } | undefined;
    const sqlState = meta?.code;
    return sqlState === '40001' || sqlState === '40P01';
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 唯一约束冲突判定。
 *
 * §18.3 的去重依赖 x_posts.x_post_id 唯一索引。虽然主路径用
 * skipDuplicates / ON CONFLICT DO NOTHING，但并发下仍可能撞上，
 * 此时应视为「已存在的重复帖子」而非错误——正常跳过即可。
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

/** 记录不存在判定（P2025）。用于人工操作前确认目标任务仍存在。 */
export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
  );
}

export { Prisma };
