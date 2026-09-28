/**
 * x-client 单测：全部走注入的 fetch stub，不发真实请求、不需要网络。
 *
 * 覆盖 §7（OAuth）、§6.1（查询参数）、§10.2（错误分类）、
 * §10.3（429 退避）、§6.3（轮询状态推导）。
 */

import { describe, expect, it } from 'vitest';

import { XAuthError, XRateLimitError, XSchemaValidationError, XTimeoutError } from './errors.js';
import { derivePollStatus, requestJson } from './http.js';
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken } from './oauth.js';
import { fetchBaselinePage, buildTimelineUrl, fetchUserTweets } from './timeline.js';

const CREDENTIALS = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://127.0.0.1:4000/api/x/oauth/callback',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubFetch(...responses: Array<() => Promise<Response>>): {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const next = responses[index] ?? responses[responses.length - 1];
    if (!next) throw new Error('no stub response');
    index += 1;
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('buildAuthorizeUrl（§7.1）', () => {
  it('包含 PKCE 与最小 scope 三件套', () => {
    const url = new URL(
      buildAuthorizeUrl(CREDENTIALS, {
        state: 'abc123',
        codeChallenge: 'challenge-value',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(CREDENTIALS.redirectUri);
    expect(url.searchParams.get('state')).toBe('abc123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // §7.2：只申请三个只读 scope
    expect(url.searchParams.get('scope')).toBe('tweet.read users.read offline.access');
  });
});

describe('exchangeCodeForToken（§7.1、§7.2）', () => {
  const tokenBody = {
    token_type: 'bearer',
    expires_in: 7200,
    access_token: 'AT',
    refresh_token: 'RT',
    scope: 'tweet.read users.read offline.access',
  };

  it('解析成功响应并使用 form-urlencoded + Basic 认证', async () => {
    const { fetchImpl, calls } = stubFetch(() => Promise.resolve(jsonResponse(tokenBody)));
    const token = await exchangeCodeForToken(CREDENTIALS, 'code-1', 'verifier-1', { fetchImpl });
    expect(token.access_token).toBe('AT');
    expect(token.refresh_token).toBe('RT');

    const call = calls[0];
    expect(call?.url).toBe('https://api.x.com/2/oauth2/token');
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Buffer.from(headers['Authorization']!.slice(6), 'base64').toString()).toBe(
      'test-client-id:test-client-secret',
    );
    expect(String(call?.init?.body)).toContain('grant_type=authorization_code');
    expect(String(call?.init?.body)).toContain('code_verifier=verifier-1');
  });

  it('缺少 offline.access 时抛错（§7.2 必需 scope）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(jsonResponse({ ...tokenBody, scope: 'tweet.read users.read' })),
    );
    await expect(
      exchangeCodeForToken(CREDENTIALS, 'c', 'v', { fetchImpl }),
    ).rejects.toThrow(/offline\.access/);
  });

  it('出现写入 scope 时抛错（§1.1 单向性）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        jsonResponse({ ...tokenBody, scope: 'tweet.read users.read offline.access tweet.write' }),
      ),
    );
    await expect(
      exchangeCodeForToken(CREDENTIALS, 'c', 'v', { fetchImpl }),
    ).rejects.toThrow(/tweet\.write/);
  });

  it('响应缺 refresh_token 视为校验失败（长期运行必需，§7.2）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        jsonResponse({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'AT',
          scope: tokenBody.scope,
        }),
      ),
    );
    await expect(
      exchangeCodeForToken(CREDENTIALS, 'c', 'v', { fetchImpl }),
    ).rejects.toThrow(XSchemaValidationError);
  });
});

describe('refreshAccessToken（§7.5）', () => {
  it('刷新响应允许 scope 缺省、refresh_token 轮换', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(
        jsonResponse({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'AT2',
          refresh_token: 'RT2',
        }),
      ),
    );
    const result = await refreshAccessToken(CREDENTIALS, 'RT', { fetchImpl });
    expect(result.access_token).toBe('AT2');
    expect(result.refresh_token).toBe('RT2');
    expect(String(calls[0]?.init?.body)).toContain('grant_type=refresh_token');
  });

  it('旧 refresh_token 被拒绝（401）时抛 XAuthError，上层应置 TOKEN_EXPIRED', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 401 })));
    await expect(refreshAccessToken(CREDENTIALS, 'RT-old', { fetchImpl })).rejects.toBeInstanceOf(
      XAuthError,
    );
  });
});

describe('buildTimelineUrl（§6.1 字段清单）', () => {
  it('带齐 expansions / 四组 fields / max_results=100', () => {
    const url = new URL(
      buildTimelineUrl({ userId: '123', accessToken: 'AT', sinceId: '100' }),
    );
    expect(url.origin + url.pathname).toBe('https://api.x.com/2/users/123/tweets');
    expect(url.searchParams.get('max_results')).toBe('100');
    expect(url.searchParams.get('since_id')).toBe('100');
    expect(url.searchParams.get('expansions')).toBe(
      'attachments.media_keys,referenced_tweets.id,author_id,edit_history_tweet_ids',
    );
    expect(url.searchParams.get('tweet.fields')).toContain('possibly_sensitive');
    expect(url.searchParams.get('media.fields')).toBe(
      'media_key,type,url,preview_image_url,width,height,alt_text,duration_ms',
    );
    expect(url.searchParams.get('user.fields')).toBe('id,username');
    expect(url.searchParams.has('pagination_token')).toBe(false);
  });

  it('baseline 用 max_results=5 且不带 since_id（§6.5）', () => {
    const url = new URL(buildTimelineUrl({ userId: '123', accessToken: 'AT', maxResults: 5 }));
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.has('since_id')).toBe(false);
  });
});

describe('fetchUserTweets（§6.1、§18.2）', () => {
  const tweet = {
    id: '111',
    text: 'hello $BTC #crypto',
    created_at: '2026-09-28T10:00:00.000Z',
  };

  it('正常响应解析并带出速率限制头', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: [tweet], meta: { result_count: 1 } }),
          {
            status: 200,
            headers: { 'x-rate-limit-remaining': '45', 'x-rate-limit-reset': '1790000000' },
          },
        ),
      ),
    );
    const result = await fetchUserTweets(
      { userId: '123', accessToken: 'AT', sinceId: '100' },
      { fetchImpl },
    );
    expect(result.resultCount).toBe(1);
    expect(result.rateLimitRemaining).toBe(45);
    expect(result.rateLimitReset).toBe(1790000000);
    expect(result.response.data?.[0]?.text).toBe('hello $BTC #crypto');
  });

  it('空响应合法：data 缺失归一化为 0 条，不报错（§18.2 不产生费用）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(jsonResponse({ meta: { result_count: 0 } })),
    );
    const result = await fetchUserTweets({ userId: '123', accessToken: 'AT' }, { fetchImpl });
    expect(result.resultCount).toBe(0);
    expect(result.response.data).toBeUndefined();
  });

  it('未知字段导致严格校验失败（§10.2 接口变更需人工介入）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(jsonResponse({ data: [{ ...tweet, brand_new_field: 1 }] })),
    );
    await expect(
      fetchUserTweets({ userId: '123', accessToken: 'AT' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(XSchemaValidationError);
  });

  it('429 → XRateLimitError，休眠时长取 reset（§10.3）', async () => {
    const nowMs = 1_790_000_000_000 - 30_000; // reset 前 30 秒
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'x-rate-limit-reset': '1790000000' } })),
    );
    await expect(
      fetchUserTweets(
        { userId: '123', accessToken: 'AT' },
        { fetchImpl, now: () => nowMs },
      ),
    ).rejects.toMatchObject({
      name: 'XRateLimitError',
      disposition: { kind: 'retry' },
      retryAfterMs: 30_000,
    });
  });

  it('401 → XAuthError', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 })));
    await expect(
      fetchUserTweets({ userId: '123', accessToken: 'AT' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(XAuthError);
  });

  it('503 → 可重试（§10.2）', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('oops', { status: 503 })));
    await expect(
      fetchUserTweets({ userId: '123', accessToken: 'AT' }, { fetchImpl }),
    ).rejects.toMatchObject({ disposition: { kind: 'retry' }, httpStatus: 503 });
  });

  it('fetch 抛 ECONNRESET 归为可重试网络错误（§10.2）', async () => {
    const fetchImpl = (async () => {
      const error = new TypeError('fetch failed');
      (error as unknown as { cause: { code: string } }).cause = { code: 'ECONNRESET' };
      throw error;
    }) as unknown as typeof fetch;
    await expect(
      fetchUserTweets({ userId: '123', accessToken: 'AT' }, { fetchImpl }),
    ).rejects.toMatchObject({ disposition: { kind: 'retry' } });
  });

  it('请求超时 → XTimeoutError（可重试）', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      })) as unknown as typeof fetch;
    await expect(
      fetchUserTweets(
        { userId: '123', accessToken: 'AT' },
        { fetchImpl, requestTimeoutMs: 10 },
      ),
    ).rejects.toBeInstanceOf(XTimeoutError);
  });

  it('baseline 页固定 max_results=5（§6.5）', async () => {
    const { fetchImpl, calls } = stubFetch(() => Promise.resolve(jsonResponse({})));
    await fetchBaselinePage('123', 'AT', { fetchImpl });
    expect(new URL(calls[0]!.url).searchParams.get('max_results')).toBe('5');
  });
});

describe('derivePollStatus（§6.3）', () => {
  it('OK / RATE_LIMITED / AUTH_FAILED / SERVER_ERROR 四类', () => {
    expect(derivePollStatus({ httpStatus: 200, rateLimitRemaining: 50 })).toBe('OK');
    expect(derivePollStatus({ httpStatus: 200, rateLimitRemaining: 2 })).toBe('RATE_LIMITED');
    expect(derivePollStatus({ httpStatus: 429 })).toBe('RATE_LIMITED');
    expect(derivePollStatus({ httpStatus: 401 })).toBe('AUTH_FAILED');
    expect(derivePollStatus({ httpStatus: 500 })).toBe('SERVER_ERROR');
  });
});

describe('requestJson 边界', () => {
  it('成功响应空 body 归一化为 {}', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    const { json } = await requestJson('https://api.x.com/2/x', {}, { fetchImpl });
    expect(json).toEqual({});
  });
});
