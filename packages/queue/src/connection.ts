/**
 * Redis 连接工厂（§10.1、§16.2）。
 *
 * BullMQ 要求 maxRetriesPerRequest=null；ioredis 的其他参数保持默认。
 * 每个用途用独立连接：队列连接与计数器/锁连接分离，避免阻塞命令互相拖累。
 */

import { Redis } from 'ioredis';

/** BullMQ/ioredis 通用连接配置（§10.1）。 */
export function connectionOptions(redisUrl: string): { url: string } & Record<string, unknown> {
  return { url: redisUrl };
}

/** BullMQ 专用连接选项（§10.1 队列依赖）。 */
export function createBullConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    // BullMQ 官方要求：null 表示不重试命令，由队列层控制重试
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** 普通键值/计数器/锁连接（允许命令级重试）。 */
export function createKeyConnection(redisUrl: string): Redis {
  return new Redis(redisUrl);
}
