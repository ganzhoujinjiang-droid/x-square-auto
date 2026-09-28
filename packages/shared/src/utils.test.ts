/**
 * 工具函数测试。
 *
 * 覆盖幂等键（§9.4）、密钥掩码（§11.6）、UTC 日键（§20.4）、
 * 模板渲染（§14.3）、扩展名映射（§11.1）。
 */

import { describe, expect, it } from 'vitest';

import {
  binanceQuotaKey,
  buildIdempotencyKey,
  extractExtension,
  extractTemplateVariables,
  maskSecret,
  oauthStateKey,
  pollLockKey,
  renderTemplate,
  sha256Hex,
  truncateForLog,
  utcDayKey,
} from './utils.js';

describe('buildIdempotencyKey（§9.4）', () => {
  it('相同输入产出相同键', () => {
    const params = {
      xPostId: '1834567890123456789',
      binanceAccountId: 'acct_1',
      contentHash: 'abc123',
    };
    expect(buildIdempotencyKey(params)).toBe(buildIdempotencyKey(params));
  });

  it('任一字段不同则键不同', () => {
    const base = {
      xPostId: '1',
      binanceAccountId: 'a',
      contentHash: 'h',
    };
    expect(buildIdempotencyKey({ ...base, contentHash: 'h2' })).not.toBe(
      buildIdempotencyKey(base),
    );
  });

  it('字段拼接不产生歧义（分隔符防碰撞）', () => {
    // ("a","bc") 与 ("ab","c") 必须产出不同键
    const k1 = buildIdempotencyKey({
      xPostId: 'a',
      binanceAccountId: 'bc',
      contentHash: 'h',
    });
    const k2 = buildIdempotencyKey({
      xPostId: 'ab',
      binanceAccountId: 'c',
      contentHash: 'h',
    });
    expect(k1).not.toBe(k2);
  });

  it('产出 64 位十六进制（sha256）', () => {
    const key = buildIdempotencyKey({
      xPostId: '1',
      binanceAccountId: 'a',
      contentHash: 'h',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('maskSecret（§11.6：前 5 位 + ... + 后 4 位）', () => {
  it('正常长度密钥按规则掩码', () => {
    // 前 5 位 abc12 + ... + 后 4 位 xyz9
    expect(maskSecret('abc123456789xyz9')).toBe('abc12...xyz9');
  });

  it('示例：abc12...xyz9', () => {
    expect(maskSecret('abc12XXXXXXXXXxyz9')).toBe('abc12...xyz9');
  });

  it('过短密钥整体掩码，避免小样本泄露', () => {
    expect(maskSecret('short')).toBe('****');
  });
});

describe('utcDayKey / binanceQuotaKey（§20.4：必须用 UTC 日）', () => {
  it('输出 yyyymmdd 格式', () => {
    const date = new Date('2026-09-27T21:30:00Z');
    expect(utcDayKey(date)).toBe('20260927');
  });

  it('用 UTC 而非本地时区（跨零点边界）', () => {
    // UTC 2026-09-27T23:59:00Z 在 Asia/Tokyo 已是 09-28，但键必须是 09-27
    const date = new Date('2026-09-27T23:59:00Z');
    expect(utcDayKey(date)).toBe('20260927');
  });

  it('配额键格式正确', () => {
    const date = new Date('2026-09-27T00:00:00Z');
    expect(binanceQuotaKey('acct_1', 'post_count', date)).toBe(
      'binance:acct_1:post_count:20260927',
    );
  });
});

describe('Redis 键构造', () => {
  it('oauthStateKey', () => {
    expect(oauthStateKey('st_1')).toBe('x:oauth:state:st_1');
  });

  it('pollLockKey', () => {
    expect(pollLockKey('acct_1')).toBe('x:poll:lock:acct_1');
  });
});

describe('renderTemplate（§14.3）', () => {
  it('替换全部已登记变量', () => {
    const result = renderTemplate('{text} by @{username} {url} {date} {hashtags}', {
      text: 'BTC up',
      username: 'trader',
      url: 'https://x.com/i/status/1',
      date: '2026-09-27',
      hashtags: '#crypto',
    });
    expect(result).toBe('BTC up by @trader https://x.com/i/status/1 2026-09-27 #crypto');
  });

  it('未提供的变量原样保留，便于发现拼写错误', () => {
    expect(renderTemplate('{text} {missing}', { text: 'hi' })).toBe('hi {missing}');
  });

  it('默认模板渲染正确', () => {
    const result = renderTemplate('{text}\n\n—\n来源：@{username}\n{url}', {
      text: '内容',
      username: 'me',
      url: 'https://x.com/i/status/1',
    });
    expect(result).toBe('内容\n\n—\n来源：@me\nhttps://x.com/i/status/1');
  });

  it('不转义 $BTC 与 #topic（§14.2：原样传递）', () => {
    const result = renderTemplate('{text}', { text: '$BTC #crypto 涨了' });
    expect(result).toBe('$BTC #crypto 涨了');
  });
});

describe('extractTemplateVariables', () => {
  it('提取已登记变量并去重', () => {
    const vars = extractTemplateVariables('{text} {text} {url}');
    expect(vars).toContain('text');
    expect(vars).toContain('url');
    expect(vars.filter((v) => v === 'text')).toHaveLength(1);
  });

  it('忽略未登记变量', () => {
    expect(extractTemplateVariables('{foo} {text}')).toEqual(['text']);
  });
});

describe('extractExtension（§11.1）', () => {
  it('从文件名提取小写扩展名', () => {
    expect(extractExtension('chart1.PNG')).toBe('png');
  });

  it('从带查询串的 URL 提取', () => {
    expect(extractExtension('https://cdn/x/photo.jpg?token=abc')).toBe('jpg');
  });

  it('无扩展名返回 null', () => {
    expect(extractExtension('README')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('产出 64 位十六进制且稳定', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('truncateForLog', () => {
  it('超长文本被截断并加省略号', () => {
    const long = 'a'.repeat(200);
    expect(truncateForLog(long, 50)).toHaveLength(50);
    expect(truncateForLog(long, 50).endsWith('…')).toBe(true);
  });

  it('短文本不截断', () => {
    expect(truncateForLog('short')).toBe('short');
  });
});
