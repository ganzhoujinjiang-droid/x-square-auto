/**
 * 事务与错误判定测试。
 *
 * 这些判定决定了系统对并发冲突的处理方式：
 *   - isUniqueConstraintError：§18.3 的去重依赖 x_posts.x_post_id 唯一索引，
 *     并发撞上时应视为「已存在的重复帖子」正常跳过，而非报错中断整批轮询。
 *   - isNotFoundError：人工操作前确认目标任务仍存在。
 *
 * 不需要真实数据库连接，仅验证错误分类逻辑。
 */

import { Prisma } from '@prisma/client';

import { describe, expect, it } from 'vitest';

import {
  isNotFoundError,
  isRetryableTransactionError,
  isUniqueConstraintError,
  retryOnTransientError,
} from './transaction.js';

/** 构造一个 Prisma 已知请求错误，用于测试分类逻辑。 */
function knownRequestError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('test error', {
    code,
    clientVersion: '6.2.1',
    ...(meta ? { meta } : {}),
  });
}

describe('isUniqueConstraintError（P2002）', () => {
  it('识别唯一约束冲突', () => {
    expect(isUniqueConstraintError(knownRequestError('P2002'))).toBe(true);
  });

  it('识别 x_posts.x_post_id 冲突的具体场景', () => {
    const error = knownRequestError('P2002', {
      target: ['x_post_id'],
      modelName: 'XPost',
    });
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it('不识别其他 Prisma 错误码', () => {
    expect(isUniqueConstraintError(knownRequestError('P2025'))).toBe(false);
    expect(isUniqueConstraintError(knownRequestError('P2003'))).toBe(false);
  });

  it('不识别非 Prisma 错误', () => {
    expect(isUniqueConstraintError(new Error('P2002'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

describe('isNotFoundError（P2025）', () => {
  it('识别记录不存在', () => {
    expect(isNotFoundError(knownRequestError('P2025'))).toBe(true);
  });

  it('不识别唯一约束冲突', () => {
    expect(isNotFoundError(knownRequestError('P2002'))).toBe(false);
  });

  it('不识别非 Prisma 错误', () => {
    expect(isNotFoundError(new Error('not found'))).toBe(false);
  });
});

describe('isRetryableTransactionError（§6.4 分布式锁之外的兜底判定）', () => {
  it('识别 P2034 写冲突', () => {
    expect(isRetryableTransactionError(knownRequestError('P2034'))).toBe(true);
  });

  it('识别 SQLSTATE 40001 / 40P01', () => {
    expect(isRetryableTransactionError(knownRequestError('P2010', { code: '40001' }))).toBe(true);
    expect(isRetryableTransactionError(knownRequestError('P2010', { code: '40P01' }))).toBe(true);
  });

  it('不识别其他错误', () => {
    expect(isRetryableTransactionError(new Error('x'))).toBe(false);
    expect(isRetryableTransactionError(knownRequestError('P2002'))).toBe(false);
  });
});

describe('retryOnTransientError（串行化冲突重试语义）', () => {
  it('业务错误立即抛出，不做无谓重试（§10.2 保守原则）', async () => {
    let attempts = 0;
    const businessError = new Error('规则校验失败');

    await expect(
      retryOnTransientError(async () => {
        attempts += 1;
        throw businessError;
      }, { maxAttempts: 3 }),
    ).rejects.toBe(businessError);

    // 非串行化冲突不得重试，否则会掩盖真实的业务失败
    expect(attempts).toBe(1);
  });

  it('Prisma 未知错误也不重试', async () => {
    let attempts = 0;
    const unknownError = new Prisma.PrismaClientUnknownRequestError('db gone', {
      clientVersion: '6.2.1',
    });

    await expect(
      retryOnTransientError(async () => {
        attempts += 1;
        throw unknownError;
      }, { maxAttempts: 3 }),
    ).rejects.toBe(unknownError);

    expect(attempts).toBe(1);
  });

  it('串行化冲突 P2034 会重试到上限后抛出', async () => {
    let attempts = 0;
    const conflict = knownRequestError('P2034');

    await expect(
      retryOnTransientError(async () => {
        attempts += 1;
        throw conflict;
      }, { maxAttempts: 2 }),
    ).rejects.toBe(conflict);

    expect(attempts).toBe(2);
  });

  it('SQLSTATE 40001（串行化失败）会重试', async () => {
    let attempts = 0;
    const deadlock = knownRequestError('P2010', { code: '40001' });

    await expect(
      retryOnTransientError(async () => {
        attempts += 1;
        throw deadlock;
      }, { maxAttempts: 2 }),
    ).rejects.toBe(deadlock);

    expect(attempts).toBe(2);
  });
});
