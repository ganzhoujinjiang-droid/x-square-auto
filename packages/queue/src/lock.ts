/**
 * Redis 分布式锁（§6.4：每账号轮询加锁，防多实例重复轮询）。
 *
 * 实现是经典的 SET NX PX + Lua 释放：只有锁的持有者能删除自己，
 * 避免「A 的锁超时后 B 拿到，A 完成时误删 B 的锁」。
 * TTL 取轮询间隔的 2 倍：进程崩溃后锁自动过期，不会永久卡死轮询。
 */

import type { Redis } from 'ioredis';
import { pollLockKey } from '@x-square/shared';

/** 释放脚本：值匹配才删除（原子操作）。 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface LockResult {
  acquired: boolean;
  /** 获取失败时为空串。 */
  token: string;
}

/**
 * 尝试获取轮询锁。
 *
 * @param ttlMs 锁自动过期时间，建议 2 × pollInterval
 * @returns acquired=false 表示其他实例正在轮询该账号，调用方应跳过本轮
 */
export async function acquirePollLock(
  redis: Redis,
  xAccountId: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis.set(pollLockKey(xAccountId), token, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

/** 释放锁；返回是否真正删除（false 说明锁已过期并被他人持有）。 */
export async function releasePollLock(
  redis: Redis,
  xAccountId: string,
  token: string,
): Promise<boolean> {
  const deleted = await redis.eval(RELEASE_SCRIPT, 1, pollLockKey(xAccountId), token);
  return Number(deleted) === 1;
}
