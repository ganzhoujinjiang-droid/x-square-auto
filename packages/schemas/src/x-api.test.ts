/**
 * X API schema 测试（§6.1、§7、§8）。
 *
 * 重点验证：
 *   - 严格校验：未登记字段必须被拒绝（§10.2 将其归为「接口变更、需人工介入」）
 *   - Snowflake 一律按字符串处理，不经 Number（§21.3）
 *   - scope 白名单：写入类 scope 必须被拒绝（§1.1 单向性声明、§7.2 最小权限）
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_X_SCOPES,
  REQUIRED_X_SCOPES,
  assertXScopes,
  xMediaSchema,
  xOAuthCallbackQuerySchema,
  xTokenResponseSchema,
  xTweetSchema,
  xUserMeResponseSchema,
  xUserTweetsResponseSchema,
} from './x-api.js';

/** 一条最小的原创图文帖，字段严格对应 §6.1 声明的 tweet.fields。 */
const ORIGINAL_PHOTO_TWEET = {
  id: '1834567890123456789',
  text: 'BTC breaks resistance $BTC #crypto',
  created_at: '2026-09-27T12:30:00.000Z',
  author_id: '123456789',
  conversation_id: '1834567890123456789',
  attachments: { media_keys: ['3_1834567890'] },
  lang: 'en',
  possibly_sensitive: false,
  edit_history_tweet_ids: ['1834567890123456789'],
};

describe('xTweetSchema', () => {
  it('解析原创图文帖', () => {
    const parsed = xTweetSchema.parse(ORIGINAL_PHOTO_TWEET);
    expect(parsed.id).toBe('1834567890123456789');
    expect(parsed.attachments?.media_keys).toEqual(['3_1834567890']);
  });

  it('Tweet ID 保持字符串，不被转成数字（§21.3）', () => {
    const parsed = xTweetSchema.parse(ORIGINAL_PHOTO_TWEET);
    expect(typeof parsed.id).toBe('string');
    expect(parsed.id).toBe('1834567890123456789');

    // 反证：这两个相邻 ID 一旦经 Number 转换就变得无法区分，
    // 因此 ID 必须以字符串保存与比较，绝不能用 z.number()。
    const nextId = '1834567890123456790';
    expect(Number(parsed.id)).toBe(Number(nextId));
    expect(parsed.id).not.toBe(nextId);
  });

  it('拒绝非数字的 Tweet ID', () => {
    expect(() => xTweetSchema.parse({ ...ORIGINAL_PHOTO_TWEET, id: 'abc' })).toThrow();
  });

  it('拒绝非 ISO 格式的 created_at', () => {
    expect(() =>
      xTweetSchema.parse({ ...ORIGINAL_PHOTO_TWEET, created_at: '2026/09/27' }),
    ).toThrow();
  });

  it('严格模式：未登记字段被拒绝（§10.2）', () => {
    expect(() =>
      xTweetSchema.parse({ ...ORIGINAL_PHOTO_TWEET, some_new_field: 'x' }),
    ).toThrow();
  });

  it('解析 reply 帖（referenced_tweets.type = replied_to，§8.1）', () => {
    const parsed = xTweetSchema.parse({
      ...ORIGINAL_PHOTO_TWEET,
      referenced_tweets: [{ type: 'replied_to', id: '1834567890000000000' }],
    });
    expect(parsed.referenced_tweets?.[0]?.type).toBe('replied_to');
  });

  it('解析 entities（含 cashtag 与 hashtag，§14.2 原样传递）', () => {
    const parsed = xTweetSchema.parse({
      ...ORIGINAL_PHOTO_TWEET,
      entities: {
        cashtags: [{ start: 19, end: 23, tag: 'BTC' }],
        hashtags: [{ start: 24, end: 31, tag: 'crypto' }],
      },
    });
    expect(parsed.entities?.cashtags?.[0]?.tag).toBe('BTC');
  });
});

describe('xMediaSchema', () => {
  it('解析 photo 媒体（含直链 url）', () => {
    const parsed = xMediaSchema.parse({
      media_key: '3_1834567890',
      type: 'photo',
      url: 'https://pbs.twimg.com/media/abc.jpg',
      width: 1200,
      height: 675,
      alt_text: 'chart',
    });
    expect(parsed.type).toBe('photo');
    expect(parsed.url).toContain('pbs.twimg.com');
  });

  it('识别 video 与 animated_gif（V1 不同步，§8.2）', () => {
    expect(
      xMediaSchema.parse({ media_key: '13_1', type: 'video', duration_ms: 3000 }).type,
    ).toBe('video');
    expect(
      xMediaSchema.parse({ media_key: '16_1', type: 'animated_gif' }).type,
    ).toBe('animated_gif');
  });

  it('拒绝未登记的媒体类型', () => {
    expect(() => xMediaSchema.parse({ media_key: '1_1', type: 'sticker' })).toThrow();
  });
});

describe('xUserTweetsResponseSchema（§6.1 唯一数据源）', () => {
  it('解析带 includes 与 meta 的完整响应', () => {
    const parsed = xUserTweetsResponseSchema.parse({
      data: [ORIGINAL_PHOTO_TWEET],
      includes: {
        media: [
          {
            media_key: '3_1834567890',
            type: 'photo',
            url: 'https://pbs.twimg.com/media/abc.jpg',
          },
        ],
      },
      meta: {
        newest_id: '1834567890123456789',
        oldest_id: '1834567890123456789',
        result_count: 1,
      },
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.meta?.result_count).toBe(1);
  });

  it('空响应：data 缺省视为无新帖（§18.2 计费依据）', () => {
    const parsed = xUserTweetsResponseSchema.parse({ meta: { result_count: 0 } });
    expect(parsed.data ?? []).toHaveLength(0);
  });

  it('解析 errors 数组（X 对部分失败的资源会返回 errors 而非整体失败）', () => {
    const parsed = xUserTweetsResponseSchema.parse({
      errors: [
        {
          title: 'Not Found Error',
          detail: 'Could not find tweet with ids: [1].',
          resource_type: 'tweet',
        },
      ],
    });
    expect(parsed.errors?.[0]?.title).toBe('Not Found Error');
  });

  it('支持分页 token（§6.6 断点恢复需循环取完）', () => {
    const parsed = xUserTweetsResponseSchema.parse({
      data: [ORIGINAL_PHOTO_TWEET],
      meta: { next_token: 'tok_abc', result_count: 1 },
    });
    expect(parsed.meta?.next_token).toBe('tok_abc');
  });
});

describe('xUserMeResponseSchema（§7.1：记录 x_user_id）', () => {
  it('解析 id 与 username', () => {
    const parsed = xUserMeResponseSchema.parse({
      data: { id: '123456789', username: 'trader', name: 'Trader' },
    });
    expect(parsed.data.id).toBe('123456789');
    expect(parsed.data.username).toBe('trader');
  });
});

describe('xTokenResponseSchema（§7.1）', () => {
  const TOKEN_RESPONSE = {
    token_type: 'bearer',
    expires_in: 7200,
    access_token: 'access-token-value',
    scope: 'tweet.read users.read offline.access',
    refresh_token: 'refresh-token-value',
  };

  it('解析完整 token 响应', () => {
    const parsed = xTokenResponseSchema.parse(TOKEN_RESPONSE);
    expect(parsed.refresh_token).toBe('refresh-token-value');
  });

  it('refresh_token 为必需（§7.2：offline.access 是长期运行必需）', () => {
    const { refresh_token: _omitted, ...withoutRefresh } = TOKEN_RESPONSE;
    expect(() => xTokenResponseSchema.parse(withoutRefresh)).toThrow();
  });

  it('拒绝非正数的 expires_in', () => {
    expect(() => xTokenResponseSchema.parse({ ...TOKEN_RESPONSE, expires_in: 0 })).toThrow();
  });
});

describe('assertXScopes（§7.2 最小权限 / §1.1 单向性声明）', () => {
  it('三项必需 scope 齐全时通过', () => {
    expect(() =>
      assertXScopes('tweet.read users.read offline.access'),
    ).not.toThrow();
  });

  it('scope 顺序不同也通过', () => {
    expect(() =>
      assertXScopes('offline.access users.read tweet.read'),
    ).not.toThrow();
  });

  it('缺少 offline.access 时报错（无法长期运行）', () => {
    expect(() => assertXScopes('tweet.read users.read')).toThrow(/offline\.access/);
  });

  it('出现 tweet.write 时报错（本系统只读 X，§1.1）', () => {
    expect(() =>
      assertXScopes('tweet.read users.read offline.access tweet.write'),
    ).toThrow(/tweet\.write/);
  });

  it('全部禁止的写入 scope 都会被拒绝', () => {
    for (const scope of FORBIDDEN_X_SCOPES) {
      expect(() =>
        assertXScopes(`${REQUIRED_X_SCOPES.join(' ')} ${scope}`),
      ).toThrow();
    }
  });
});

describe('xOAuthCallbackQuerySchema（§7.1）', () => {
  it('解析成功回调（code + state）', () => {
    const parsed = xOAuthCallbackQuerySchema.parse({ code: 'auth-code', state: 'st_1' });
    expect('code' in parsed).toBe(true);
  });

  it('解析用户拒绝授权（error，§7.1 两种情况都要能解析）', () => {
    const parsed = xOAuthCallbackQuerySchema.parse({
      error: 'access_denied',
      error_description: 'User denied access',
      state: 'st_1',
    });
    expect('error' in parsed).toBe(true);
  });

  it('拒绝缺少 state 的成功回调（CSRF 防护，§7.1）', () => {
    expect(() => xOAuthCallbackQuerySchema.parse({ code: 'auth-code' })).toThrow();
  });
});
