/**
 * 内存版 Redis stub（仅供单元测试）。
 *
 * queue 包的锁与配额逻辑只用到 GET/SET(NX,PX)/DEL/EVAL(释放脚本)/INCR/PEXPIRE/MULTI。
 * 这里实现这些命令的最小语义，让测试不依赖真实 Redis——本机也没有跑 Redis 服务。
 */

import type { Redis } from 'ioredis';

interface Entry {
  value: string;
  /** 过期时间戳（毫秒）；null 表示永不过期。 */
  expiresAt: number | null;
}

export class MemoryRedis {
  private store = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null> {
    // 支持 SET key value PX <ms> NX
    let pxMs: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === 'PX') pxMs = Number(args[i + 1]);
      if (token === 'NX') nx = true;
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, {
      value,
      expiresAt: pxMs !== null ? Date.now() + pxMs : null,
    });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const current = this.live(key)?.value ?? '0';
    const next = Number(current) + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ms;
    return 1;
  }

  /** EVAL 仅支持本包的「值匹配才删除」释放脚本语义。 */
  async eval(_script: string, _numKeys: number, key: string, arg: string): Promise<number> {
    const entry = this.live(key);
    if (entry && entry.value === arg) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  /** 暴露给测试断言内部状态。 */
  peek(key: string): string | null {
    return this.live(key)?.value ?? null;
  }
}

/** 把 MemoryRedis 适配成 ioredis 的局部接口形状。 */
export function asRedisLike(fake: MemoryRedis): Redis {
  return fake as unknown as Redis;
}
