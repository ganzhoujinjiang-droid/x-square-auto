/**
 * Snowflake 测试（§21.3、§6.4）。
 *
 * 重点验证超出 JS 安全整数范围的 ID 不会丢精度，
 * 以及 §6.4「不能按数组顺序取最后一个」的约束。
 */

import { describe, expect, it } from 'vitest';

import {
  compareSnowflake,
  isSnowflake,
  isSnowflakeGreaterThan,
  maxSnowflake,
  minSnowflake,
  parseSnowflake,
  snowflakeToTimestampMs,
  sortSnowflakeAsc,
  tryParseSnowflake,
} from './snowflake.js';

/** 一个真实量级的 Tweet ID（> 2^53，Number 无法精确表示）。 */
const BIG_ID = '1834567890123456789';
const BIG_ID_PLUS_ONE = '1834567890123456790';

describe('isSnowflake', () => {
  it('接受纯数字字符串', () => {
    expect(isSnowflake(BIG_ID)).toBe(true);
    expect(isSnowflake('0')).toBe(true);
  });

  it('拒绝负号、小数、非数字、非字符串', () => {
    expect(isSnowflake('-1')).toBe(false);
    expect(isSnowflake('1.5')).toBe(false);
    expect(isSnowflake('12a')).toBe(false);
    expect(isSnowflake(123)).toBe(false);
    expect(isSnowflake(null)).toBe(false);
  });
});

describe('大整数不丢精度（§21.3）', () => {
  it('超过 2^53 的 ID 用 Number 会丢精度，用 BigInt 不会', () => {
    // Number 表示 BIG_ID_PLUS_ONE 与 BIG_ID 相同（精度丢失）
    expect(Number(BIG_ID)).toBe(Number(BIG_ID_PLUS_ONE));
    // BigInt 能区分
    expect(compareSnowflake(BIG_ID_PLUS_ONE, BIG_ID)).toBe(1);
  });

  it('parseSnowflake 返回 BigInt', () => {
    expect(typeof parseSnowflake(BIG_ID)).toBe('bigint');
  });

  it('非法格式抛错而非静默返回 NaN', () => {
    expect(() => parseSnowflake('abc')).toThrow(TypeError);
  });

  it('tryParseSnowflake 失败返回 null', () => {
    expect(tryParseSnowflake(BIG_ID)).toBe(BigInt(BIG_ID));
    expect(tryParseSnowflake('abc')).toBeNull();
    expect(tryParseSnowflake(undefined)).toBeNull();
  });
});

describe('maxSnowflake（§6.4：不能按数组顺序取最后一个）', () => {
  it('乱序数组也能取到真正的最大值', () => {
    // X API 默认倒序返回，但分页/回溯场景顺序不可依赖
    const ids = ['100', BIG_ID, '50', BIG_ID_PLUS_ONE, '999'];
    expect(maxSnowflake(ids)).toBe(BIG_ID_PLUS_ONE);
  });

  it('空数组返回 null', () => {
    expect(maxSnowflake([])).toBeNull();
  });

  it('含非法值抛错', () => {
    expect(() => maxSnowflake(['100', 'abc'])).toThrow(TypeError);
  });

  it('最后一个不是最大值时仍返回正确的最大值', () => {
    expect(maxSnowflake([BIG_ID_PLUS_ONE, '100'])).toBe(BIG_ID_PLUS_ONE);
  });
});

describe('minSnowflake', () => {
  it('取到最小值', () => {
    expect(minSnowflake(['100', BIG_ID, '50'])).toBe('50');
  });

  it('空数组返回 null', () => {
    expect(minSnowflake([])).toBeNull();
  });
});

describe('sortSnowflakeAsc（§6.4：按 ID 升序等价于按时间升序）', () => {
  it('按数值升序而非字典序排列', () => {
    // 字典序会把 '100' 排在 '50' 前，数值序不会
    expect(sortSnowflakeAsc(['100', '50', '9'])).toEqual(['9', '50', '100']);
  });

  it('大 ID 正确排在末尾', () => {
    expect(sortSnowflakeAsc(['999', BIG_ID, '100'])).toEqual(['100', '999', BIG_ID]);
  });

  it('不修改原数组', () => {
    const original = ['3', '1', '2'];
    const sorted = sortSnowflakeAsc(original);
    expect(original).toEqual(['3', '1', '2']);
    expect(sorted).toEqual(['1', '2', '3']);
  });
});

describe('比较函数', () => {
  it('compareSnowflake 返回 -1 / 0 / 1', () => {
    expect(compareSnowflake('1', '2')).toBe(-1);
    expect(compareSnowflake('2', '2')).toBe(0);
    expect(compareSnowflake('3', '2')).toBe(1);
  });

  it('isSnowflakeGreaterThan 用于 since_id 判定', () => {
    expect(isSnowflakeGreaterThan(BIG_ID_PLUS_ONE, BIG_ID)).toBe(true);
    expect(isSnowflakeGreaterThan(BIG_ID, BIG_ID)).toBe(false);
    expect(isSnowflakeGreaterThan(BIG_ID, BIG_ID_PLUS_ONE)).toBe(false);
  });
});

describe('snowflakeToTimestampMs（仅日志排错用）', () => {
  it('反解出合理的时间戳', () => {
    const ts = snowflakeToTimestampMs(BIG_ID);
    // 该 ID 对应 2024 年附近，落在合理区间即可
    expect(ts).toBeGreaterThan(new Date('2020-01-01').getTime());
    expect(ts).toBeLessThan(new Date('2030-01-01').getTime());
  });
});
