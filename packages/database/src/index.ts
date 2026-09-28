/**
 * @x-square/database —— Prisma 客户端单例与事务封装（§4）。
 *
 * 只暴露客户端与事务工具。具体的读写操作（repository）在 API / Worker 层实现，
 * 本包不承载业务逻辑，避免与 packages 之间的循环依赖。
 */

export * from './client.js';
export * from './transaction.js';

// 重新导出 Prisma 生成的模型类型，业务层无需直接依赖 @prisma/client。
export type {
  AdminUser,
  ApiUsageLog,
  AuditLog,
  BinanceAccount,
  BinancePost,
  JobStatus,
  Setting,
  SyncJob,
  SyncJobEvent,
  XAccount,
  XPost,
} from '@prisma/client';
