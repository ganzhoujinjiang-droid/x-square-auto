/**
 * x-client 单元测试：不发真实网络请求，fetch 全部注入 stub。
 *
 * 覆盖：
 *   - OAuth scope 白名单（§7.2）与 token 交换/刷新；
 *   - 时间线 URL 参数拼装（§6.1 字段清单逐一对应）；
 *   - 429 退避时长计算（§10.3）；
 *   - Zod 校验失败按不可重试处置（§10.2）；
 *   - baseline 空响应归一化（§18.2）。
 */

import { describe, expect, it } from 'vitest';

import {
  XAuthError,
  XRateLimitError,
  XSchemaValidationError,
} from './errors.js';
import { derivePollStatus, requestJson } from './http.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchUsersMe,
  refreshAccessToken,
} from './oauth.js';
import { buildTimelineUrl, fetchBaselinePage, fetchUserTweets } from './timeline.js';

/** 构造一个最小 Response。 */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

const CREDENTIALS = {
  clientId: 'client-id-1',
  clientSecret: 'client-secret-1',
  redirectUri: 'http://127.0.0.1:4000/api/x/oauth/callback',
};

describe('buildAuthorizeUrl（§7.1）', () => {
  it('携带 PKCE 与最小 scope 集合', () => {
    const url = new URL(
      buildAuthorizeUrl(CREDENTIALS, { state: 'abc', codeChallenge: 'chal' }),
    );
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('tweet.read users.read offline.access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('abc');
  });
});

describe('exchangeCodeForToken（§7.1、§7.2）', () => {
  const okTokenBody = {
    token_type: 'bearer',
    expires_in: 7200,
    access_token: 'at-1',
    scope: 'tweet.read users.read offline.access',
    refresh_token: 'rt-1',
  };

  it('成功换取并返回 Token', async () => {
    const result = await exchangeCodeForToken(
      CREDENTIALS,
      'code-1',
      'verifier-1',
      { fetchImpl: (async () => jsonResponse(okTokenBody)) as typeof fetch },
    );
    expect(result.access_token).toBe('at-1');
    expect(result.refresh_token).toBe('rt-1');
  });

  it('缺少必需 scope 时抛错（§7.2 最小权限）', async () => {
    await expect(
      exchangeCodeForToken(
        CREDENTIALS,
        'code-1',
        'v',
        {
          fetchImpl: (async () =>
            jsonResponse({ ...okTokenBody, scope: 'tweet.read users.read' })) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/offline\.access/);
  });

  it('出现写入 scope 时拒绝（§1.1 单向性）', async () => {
    await expect(
      exchangeCodeForToken(
        CREDENTIALS,
        'code-1',
        'v',
        {
          fetchImpl: (async () =>
            jsonResponse({
              ...okTokenBody,
              scope: 'tweet.read users.read offline.access tweet.write',
            })) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/tweet\.write/);
  });

  it('用 Basic 认证头提交机密客户端凭据', async () => {
    let seenAuth = '';
    await exchangeCodeForToken(CREDENTIALS, 'c', 'v', {
      fetchImpl: (async (_url, init) => {
        seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        return jsonResponse(okTokenBody);
      }) as typeof fetch,
    });
    expect(seenAuth.startsWith('Basic ')).toBe(true);
    // secret 不应出现在 URL（只进 header），这里仅验证 header 形态
    expect(seenAuth.length).toBeGreaterThan(6);
  });
});

describe('refreshAccessToken（§7.5）', () => {
  it('刷新响应允许缺 refresh_token（由上层判定 TOKEN_EXPIRED）', async () => {
    const result = await refreshAccessToken(CREDENTIALS, 'rt-old', {
      fetchImpl: (async () =>
        jsonResponse({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'at-new',
        })) as typeof fetch,
    });
    expect(result.access_token).toBe('at-new');
    expect(result.refresh_token).toBeUndefined();
  });

  it('结构不符 schema 时按不可重试抛出（§10.2）', async () => {
    await expect(
      refreshAccessToken(CREDENTIALS, 'rt', {
        fetchImpl: (async () => jsonResponse({ weird: true })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XSchemaValidationError);
  });
});

describe('fetchUsersMe（§7.1）', () => {
  it('返回 id 与 username', async () => {
    const me = await fetchUsersMe('at-1', {
      fetchImpl: (async () =>
        jsonResponse({ data: { id: '111', username: 'me' } })) as typeof fetch,
    });
    expect(me).toEqual({ id: '111', username: 'me' });
  });
});

describe('buildTimelineUrl（§6.1）', () => {
  it('拼齐 expansions / tweet.fields / media.fields / user.fields', () => {
    const url = new URL(
      buildTimelineUrl({ userId: '111', accessToken: 'at', sinceId: '222' }),
    );
    expect(url.pathname).toBe('/2/users/111/tweets');
    expect(url.searchParams.get('max_results')).toBe('100');
    expect(url.searchParams.get('since_id')).toBe('222');
    expect(url.searchParams.get('expansions')).toContain('attachments.media_keys');
    expect(url.searchParams.get('tweet.fields')).toContain('edit_history_tweet_ids');
    expect(url.searchParams.get('media.fields')).toContain('duration_ms');
    expect(url.searchParams.get('user.fields')).toBe('id,username');
    expect(url.searchParams.get('pagination_token')).toBeNull();
  });

  it('baseline 不带 since_id，max_results=5（§6.5）', async () => {
    let seenUrl = '';
    await fetchBaselinePage('111', 'at', {
      fetchImpl: (async (url) => {
        seenUrl = String(url);
        return jsonResponse({ meta: { result_count: 0 } });
      }) as typeof fetch,
    });
    const parsed = new URL(seenUrl);
    expect(parsed.searchParams.get('max_results')).toBe('5');
    expect(parsed.searchParams.get('since_id')).toBeNull();
  });
});

describe('fetchUserTweets（§18.2 空响应合法）', () => {
  it('data 缺失归一化为空数组且 resultCount=0', async () => {
    const result = await fetchUserTweets(
      { userId: '1', accessToken: 'at' },
      { fetchImpl: (async () => jsonResponse({ meta: { result_count: 0 } })) as typeof fetch },
    );
    expect(result.resultCount).toBe(0);
    expect(result.response.data ?? []).toHaveLength(0);
  });

  it('未知额外字段导致严格校验失败（接口变更需人工介入，§10.2）', async () => {
    await expect(
      fetchUserTweets(
        { userId: '1', accessToken: 'at' },
        {
          fetchImpl: (async () =>
            jsonResponse({ data: [{ id: '1', text: 'hi', created_at: '2026-01-01T00:00:00Z' }], surprise: 1 })) as typeof fetch,
        },
      ),
    ).rejects.toBeInstanceOf(XSchemaValidationError);
  });

  it('携带速率限制元数据供上层决策', async () => {
    const result = await fetchUserTweets(
      { userId: '1', accessToken: 'at' },
      {
        fetchImpl: (async () =>
          jsonResponse(
            { data: [] },
            { headers: { 'x-rate-limit-remaining': '45', 'x-rate-limit-reset': '1770000000' } },
          )) as typeof fetch,
      },
    );
    expect(result.rateLimitRemaining).toBe(45);
    expect(result.rateLimitReset).toBe(1770000000);
  });
});

describe('429 处理（§10.3）', () => {
  it('读取 reset 头计算休眠时长并抛 XRateLimitError', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const resetSec = Math.floor(nowMs / 1000) + 60;
    await expect(
      requestJson(
        'https://api.x.com/2/users/me',
        {},
        {
          now: () => nowMs,
          fetchImpl: (async () =>
            jsonResponse({ title: 'Too Many Requests' }, { status: 429, headers: { 'x-rate-limit-reset': String(resetSec) } })) as typeof fetch,
        },
      ),
    ).rejects.toBeInstanceOf(XRateLimitError);
  });

  it('Retry-After 存在时参与取最大值', async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    const err = await requestJson('https://api.x.com/x', {}, {
      now: () => nowMs,
      fetchImpl: (async () =>
        jsonResponse({}, { status: 429, headers: { 'retry-after': '120', 'x-rate-limit-reset': String(Math.floor(nowMs / 1000) + 10) } })) as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XRateLimitError);
    expect((err as XRateLimitError).retryAfterMs).toBeGreaterThanOrEqual(120_000);
  });
});

describe('错误分类（§10.2）', () => {
  it('401 → XAuthError（fail，不重试）', async () => {
    await expect(
      requestJson('https://api.x.com/x', {}, {
        fetchImpl: (async () => jsonResponse({}, { status: 401 })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XAuthError);
  });

  it('500 → retry 处置', async () => {
    const err = await requestJson('https://api.x.com/x', {}, {
      fetchImpl: (async () => jsonResponse({}, { status: 500 })) as typeof fetch,
    }).catch((e: unknown) => e);
    expect((err as { disposition: { kind: string } }).disposition.kind).toBe('retry');
  });

  it('未登记的 4xx → fail（保守原则 §11.4）', async () => {
    const err = await requestJson('https://api.x.com/x', {}, {
      fetchImpl: (async () => jsonResponse({}, { status: 404 })) as typeof fetch,
    }).catch((e: unknown) => e);
    expect((err as { disposition: { kind: string } }).disposition.kind).toBe('fail');
  });
});

describe('derivePollStatus（§6.3）', () => {
  it('remaining 低于阈值视为 RATE_LIMITED', () => {
    expect(derivePollStatus({ httpStatus: 200, rateLimitRemaining: 1 })).toBe('RATE_LIMITED');
    expect(derivePollStatus({ httpStatus: 200, rateLimitRemaining: 40 })).toBe('OK');
    expect(derivePollStatus({ httpStatus: 503 })).toBe('SERVER_ERROR');
  });
});
