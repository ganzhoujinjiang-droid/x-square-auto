/**
 * workers 纯逻辑单测：filtering 规则引擎 + x-monitor 排序/准备函数。
 *
 * 涉及数据库与队列的处理器（handleSyncPost 等）需要真实 Postgres/Redis，
 * 属服务器端端到端验收范围；这里只覆盖可纯函数化的判定逻辑。
 */

import { describe, expect, it } from 'vitest';

import { evaluateSyncRules, checkMediaSize, type FilterablePost } from './filtering.js';
import { prepareTweets, sortOldToNew } from './x-monitor.js';
import type { UserTweetsResult } from '@x-square/x-client';

const POST = (overrides: Partial<FilterablePost> = {}): FilterablePost => ({
  postType: 'ORIGINAL',
  text: 'hello $BTC world',
  mediaTypes: [],
  photoCount: 0,
  ...overrides,
});

describe('evaluateSyncRules（§8.2 / §17.5）', () => {
  it('原创默认同步', () => {
    expect(evaluateSyncRules(POST()).sync).toBe(true);
  });

  it('Reply/Repost/Quote 默认 FILTERED 且原因可查', () => {
    for (const t of ['REPLY', 'REPOST', 'QUOTE'] as const) {
      const d = evaluateSyncRules(POST({ postType: t }));
      expect(d.sync).toBe(false);
      if (!d.sync) expect(d.reason).toContain(t);
    }
  });

  it('开启 Reply 开关后放行（不建议但允许配置）', () => {
    expect(evaluateSyncRules(POST({ postType: 'REPLY' }), { postTypes: { reply: true } }).sync).toBe(true);
  });

  it('视频/GIF 硬禁（V1 不开放，§8.2）', () => {
    const d = evaluateSyncRules(POST({ mediaTypes: ['video'] }));
    expect(d.sync).toBe(false);
    if (!d.sync) expect(d.reason).toContain('V1 不支持');
  });

  it('排除词一票否决，优先于包含词（§17.5）', () => {
    const d = evaluateSyncRules(POST({ text: 'buy my course now' }), {
      keywords: { include: ['course'], exclude: ['my course'] },
    });
    expect(d.sync).toBe(false);
    if (!d.sync) expect(d.reason).toContain('排除关键词');
  });

  it('包含词留空表示不过滤', () => {
    expect(evaluateSyncRules(POST(), { keywords: { include: [] } }).sync).toBe(true);
  });

  it('包含词未命中 → FILTERED', () => {
    const d = evaluateSyncRules(POST({ text: 'plain text' }), { keywords: { include: ['btc'] } });
    expect(d.sync).toBe(false);
  });

  it('大小写不敏感是默认（§17.5）', () => {
    expect(evaluateSyncRules(POST({ text: 'HELLO' }), { keywords: { include: ['hello'] } }).sync).toBe(true);
    const sensitive = evaluateSyncRules(POST({ text: 'HELLO' }), {
      keywords: { include: ['hello'], caseSensitive: true },
    });
    expect(sensitive.sync).toBe(false);
  });

  it('>4 图拒绝（§11.2）', () => {
    const d = evaluateSyncRules(POST({ mediaTypes: ['photo'], photoCount: 5 }));
    expect(d.sync).toBe(false);
  });

  it('正文 >280 字符软预警但不拦截（§14.3）', () => {
    const d = evaluateSyncRules(POST({ text: 'a'.repeat(300) }));
    expect(d.sync).toBe(true);
    if (d.sync) expect(d.contentLengthWarn).toBe(true);
  });
});

describe('checkMediaSize（§12）', () => {
  it('超 15MB 拒绝', () => {
    expect(checkMediaSize(16 * 1024 * 1024).ok).toBe(false);
  });
  it('空文件拒绝', () => {
    expect(checkMediaSize(0).ok).toBe(false);
  });
  it('正常放行', () => {
    expect(checkMediaSize(1024).ok).toBe(true);
  });
});

describe('prepareTweets / sortOldToNew（§6.4 / §8.1）', () => {
  const tweet = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    text: `t-${id}`,
    created_at: '2026-09-28T00:00:00Z',
    ...extra,
  });

  const result = (tweets: unknown[]): UserTweetsResult => ({
    response: { data: tweets } as never,
    resultCount: tweets.length,
  });

  it('乱序 ID 按旧→新排序（Snowflake 数值序，非数组序）', () => {
    const prepared = prepareTweets(result([tweet('300'), tweet('100'), tweet('200')]));
    const sorted = sortOldToNew(prepared).map((t) => t.id);
    expect(sorted).toEqual(['100', '200', '300']);
  });

  it('媒体展开：photo 计数与类型表', () => {
    const prepared = prepareTweets(
      result([
        tweet('100', {
          attachments: { media_keys: ['m1', 'm2'] },
        }),
      ]),
    );
    // includes.media 缺失时 keys 保留但类型为空——展开由 X API 保证
    expect(prepared[0]!.mediaKeys).toEqual(['m1', 'm2']);
  });

  it('includes 提供 media 时归类 photo/video', () => {
    const withIncludes = {
      response: {
        data: [tweet('100', { attachments: { media_keys: ['m1', 'm2'] } })],
        includes: {
          media: [
            { media_key: 'm1', type: 'photo', url: 'https://cdn/1.jpg' },
            { media_key: 'm2', type: 'video' },
          ],
        },
      },
      resultCount: 1,
    } as unknown as UserTweetsResult;
    const prepared = prepareTweets(withIncludes);
    expect(prepared[0]!.photoCount).toBe(1);
    expect(prepared[0]!.mediaTypes).toEqual(['photo', 'video']);
  });
});
