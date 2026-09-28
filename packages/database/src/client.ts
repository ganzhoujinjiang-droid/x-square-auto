/**
 * Prisma 客户端单例（§4：Prisma 6.x + PostgreSQL 16）。
 *
 * 单例的必要性：API 与 Worker 都是长驻进程，每次操作新建客户端会耗尽连接池。
 * Next.js 开发模式下的热重载会重复执行模块，因此用 globalThis 缓存。
 */

import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端实例类型，供事务封装与各 repository 使用。
 *
 * 命名为 PrismaClientInstance 而非 Prisma，是为了避免与 transaction.ts 导出的
 * Prisma 命名空间（含 TransactionIsolationLevel、PrismaClientKnownRequestError 等）
 * 在包入口发生导出名冲突。
 */
export type PrismaClientInstance = PrismaClient;

/**
 * 交互式事务客户端类型。
 *
 * §6.4 要求 last_tweet_id 的推进必须与帖子写入在同一事务内提交，
 * 因此事务封装需要把这个类型暴露给调用方。
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const GLOBAL_KEY = Symbol.for('x-square-auto.prisma');

interface PrismaGlobal {
  [GLOBAL_KEY]?: PrismaClient;
}

/**
 * 取得进程内唯一的 Prisma 客户端。
 *
 * @param options.log 覆盖默认日志级别。生产为 info（§20.2），排错时可传 warn/error。
 */
export function getPrismaClient(options: { log?: boolean } = {}): PrismaClient {
  const globalStore = globalThis as unknown as PrismaGlobal;
  const existing = globalStore[GLOBAL_KEY];
  if (existing) {
    return existing;
  }

  const client = new PrismaClient({
    // 只输出警告与错误：正常业务日志由 Pino 统一产出（§20.2），
    // 避免 Prisma 的 query 日志把敏感字段带进日志流（§7.6 日志红线）。
    log: options.log === true ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  globalStore[GLOBAL_KEY] = client;
  return client;
}

/** 便捷别名：多数业务模块直接 import 该实例。 */
export const prisma = getPrismaClient();

/**
 * 断开连接。
 *
 * 进程优雅退出时调用（§10.4 的崩溃恢复前提是任务状态已持久化，
 * 而未 flush 的连接缓冲会造成状态丢失）。
 */
export async function disconnectPrisma(): Promise<void> {
  const globalStore = globalThis as unknown as PrismaGlobal;
  const existing = globalStore[GLOBAL_KEY];
  if (existing) {
    await existing.$disconnect();
    delete globalStore[GLOBAL_KEY];
  }
}

/** 连接可用性探测，供 /health 的 database 检查项使用（§20.1）。 */
export async function checkDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}
