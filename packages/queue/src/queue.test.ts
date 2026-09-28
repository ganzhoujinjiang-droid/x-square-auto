/**
 * queue 包单测：锁与配额用 MemoryRedis，不依赖真实 Redis。
 *
 * 覆盖 §6.4（分布式锁互斥与安全释放）、§11.3（UTC 日滚动、硬限额拒绝、预警阈值）。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryRedis, asRedisLike } from './memory-redis.js';
import { acquirePollLock, releasePollLock } from './lock.js';
import { checkQuota, reserveQuota } from './quota.js';

let fake: MemoryRedis;
beforeEach(() => {
  fake = new MemoryRedis();
});

describe('轮询分布式锁（§6.4）', () => {
  const ACCOUNT = 'xa_1';

  it('同一账号第二个实例拿不到锁', async () => {
    const redis = asRedisLike(fake);
    expect(await acquirePollLock(redis, ACCOUNT, 'tok-A', 60_000)).toBe(true);
    expect(await acquirePollLock(redis, ACCOUNT, 'tok-B', 60_000)).toBe(false);
  });

  it('释放后其他实例可获取', async () => {
    const redis = asRedisLike(fake);
    await acquirePollLock(redis, ACCOUNT, 'tok-A', 60_000);
    expect(await releasePollLock(redis, ACCOUNT, 'tok-A')).toBe(true);
    expect(await acquirePollLock(redis, ACCOUNT, 'tok-B', 60_000)).toBe(true);
  });

  it('非持有者不能删别人的锁（A 超时后误删场景）', async () => {
    const redis = asRedisLike(fake);
    await acquirePollLock(redis, ACCOUNT, 'tok-A', 1); // 极短 TTL
    await new Promise((r) => setTimeout(r, 5)); // 等过期
    await acquirePollLock(redis, ACCOUNT, 'tok-B', 60_000); // B 接管
    expect(await releasePollLock(redis, ACCOUNT, 'tok-A')).toBe(false); // A 迟到的释放失败
    expect(fake.peek(`x:poll:lock:${ACCOUNT}`)).toBe('tok-B'); // B 的锁仍在
  });

  it('不同账号互不影响', async () => {
    const redis = asRedisLike(fake);
    expect(await acquirePollLock(redis, 'a1', 't', 60_000)).toBe(true);
    expect(await acquirePollLock(redis, 'a2', 't', 60_000)).toBe(true);
  });
});

describe('Binance 日配额（§11.3）', () => {
  const ACCOUNT = 'ba_1';

  it('空计数默认允许且未预警', async () => {
    const check = await checkQuota(asRedisLike(fake), ACCOUNT, 'post_count');
    expect(check).toEqual({ allowed: true, used: 0, limit: 100, warn: false });
  });

  it('预占累加并触发预警（95）', async () => {
    const redis = asRedisLike(fake);
    for (let i = 0; i < 95; i += 1) {
      await reserveQuota(redis, ACCOUNT, 'post_count');
    }
    const check = await checkQuota(redis, ACCOUNT, 'post_count');
    expect(check.used).toBe(95);
    expect(check.warn).toBe(true);
    expect(check.allowed).toBe(true);
  });

  it('达 100 后拒绝继续（不发请求等 220009）', async () => {
    const redis = asRedisLike(fake);
    let lastAllowed = true;
    for (let i = 0; i < 101; i += 1) {
      lastAllowed = (await reserveQuota(redis, ACCOUNT, 'post_count')).allowed;
    }
    expect(lastAllowed).toBe(false);
  });

  it('上传限额独立于发帖限额（400 vs 100）', async () => {
    const redis = asRedisLike(fake);
    await reserveQuota(redis, ACCOUNT, 'post_count');
    const upload = await checkQuota(redis, ACCOUNT, 'upload_count');
    expect(upload.used).toBe(0);
    expect(upload.limit).toBe(400);
  });

  it('键按 UTC 日滚动，跨日重新计数（§20.4）', async () => {
    const redis = asRedisLike(fake);
    const day1 = new Date(Date.UTC(2026, 0, 1, 23, 59));
    const day2 = new Date(Date.UTC(2026, 0, 2, 0, 1));
    for (let i = 0; i < 100; i += 1) await reserveQuota(redis, ACCOUNT, 'post_count', day1);
    const afterMidnight = await checkQuota(redis, ACCOUNT, 'post_count', day2);
    expect(afterMidnight.used).toBe(0);
    expect(afterMidnight.allowed).toBe(true);
  });
});
