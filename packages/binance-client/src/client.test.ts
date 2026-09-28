/**
 * binance-client 单元测试：fetch 注入 stub，不发真实请求。
 *
 * 覆盖 §11.1 的关键陷阱：V1/V2 路径分离、code==="000000" 字符串判定、
 * PUT 不带密钥头、504/超时→UNCERTAIN、未登记错误码保守 FAILED（§11.4）。
 */

import { describe, expect, it } from 'vitest';

import {
  contentTypeForImage,
  getPresignedUrl,
  getImageStatus,
  publishShortPost,
  uploadToPresignedUrl,
} from './api.js';
import { BinanceApiError, BinanceBusinessError, BinanceUploadError } from './errors.js';

const OPTS = (fetchImpl: typeof fetch) => ({ apiKey: 'k', fetchImpl });

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('contentTypeForImage（§11.1 PUT 映射）', () => {
  it('按扩展名映射，未知回退 octet-stream', () => {
    expect(contentTypeForImage('a.png')).toBe('image/png');
    expect(contentTypeForImage('https://x/y.jpeg')).toBe('image/jpeg');
    expect(contentTypeForImage('clip.mp4')).toBe('video/mp4');
    expect(contentTypeForImage('weird.bin')).toBe('application/octet-stream');
  });
});

describe('getPresignedUrl（V2，§11.1）', () => {
  it('请求走 V2 base 且带统一头', async () => {
    let seenUrl = '';
    let seenKeyHeader = '';
    await getPresignedUrl('chart1.png', OPTS((async (url, init) => {
      seenUrl = String(url);
      seenKeyHeader = String((init?.headers as Record<string, string>)['X-Square-OpenAPI-Key']);
      return jsonResponse({ code: '000000', data: { presignedUrl: 'https://up/1', fileTicket: 'ft-1' } });
    }) as typeof fetch));
    expect(seenUrl).toContain('/v2/public/pgc/openApi/image/presignedUrl');
    expect(seenKeyHeader).toBe('k');
  });

  it('业务 code 非 000000 → BinanceBusinessError（FAILED）', async () => {
    await expect(
      getPresignedUrl('a.png', OPTS((async () =>
        jsonResponse({ code: '220003', message: 'key not found' })) as typeof fetch)),
    ).rejects.toBeInstanceOf(BinanceBusinessError);
  });
});

describe('uploadToPresignedUrl（PUT，§11.1）', () => {
  it('不携带 X-Square-OpenAPI-Key，凭据在 URL 内', async () => {
    let headers: Record<string, string> = {};
    await uploadToPresignedUrl(
      'https://up/1?sig=x',
      Buffer.from([1, 2, 3]),
      'chart1.png',
      { fetchImpl: (async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return new Response(null, { status: 200 });
      }) as typeof fetch },
    );
    expect(headers['X-Square-OpenAPI-Key']).toBeUndefined();
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('非 2xx → BinanceUploadError（retry）', async () => {
    await expect(
      uploadToPresignedUrl('https://up/1', Buffer.from([1]), 'a.png', {
        fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(BinanceUploadError);
  });
});

describe('getImageStatus（V2，§11.1）', () => {
  it('status=1 返回 imageUrl', async () => {
    const data = await getImageStatus('ft-1', OPTS((async () =>
      jsonResponse({ code: '000000', data: { status: 1, imageUrl: 'https://img/1' } })) as typeof fetch));
    expect(data.status).toBe(1);
    expect(data.imageUrl).toBe('https://img/1');
  });

  it('status=2 由上层读 failedReason（客户端只透传数据）', async () => {
    const data = await getImageStatus('ft-1', OPTS((async () =>
      jsonResponse({ code: '000000', data: { status: 2, failedReason: 'bad image' } })) as typeof fetch));
    expect(data.failedReason).toBe('bad image');
  });
});

describe('publishShortPost（V1 /content/add，§9.3、§11.1）', () => {
  const okBody = { code: '000000', data: { id: '9988776655', shareLink: 'https://sq/1' } };

  it('发布请求必须走 V1 base（全部用 V2 会失败，§11.1）', async () => {
    let seenUrl = '';
    await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hello $BTC' },
      { apiKey: 'k', fetchImpl: (async (url) => { seenUrl = String(url); return jsonResponse(okBody); }) as typeof fetch },
    );
    expect(seenUrl).toContain('/v1/public/pgc/openApi/content/add');
  });

  it('成功拿到 id → published_with_id', async () => {
    const result = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => jsonResponse(okBody)) as typeof fetch),
    );
    expect(result.outcome).toBe('published_with_id');
    expect(result.postId).toBe('9988776655');
  });

  it('成功但无 id → published_without_id（官方 504 语义留给人工确认，§9.3）', async () => {
    const result = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => jsonResponse({ code: '000000', data: {} })) as typeof fetch),
    );
    expect(result.outcome).toBe('published_without_id');
    expect(result.postId).toBeNull();
  });

  it('HTTP 504 → uncertain，绝不自动重试（§9.3）', async () => {
    const err = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => new Response('', { status: 504 })) as typeof fetch),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect((err as BinanceApiError).disposition.kind).toBe('uncertain');
  });

  it('ECONNRESET（发布阶段连接中断）→ uncertain', async () => {
    const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const err = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => { throw reset; }) as typeof fetch),
    ).catch((e: unknown) => e);
    expect((err as BinanceApiError).disposition.kind).toBe('uncertain');
  });

  it('响应无法解析 → uncertain（结果未知，§9.3）', async () => {
    const err = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => new Response('<html>gateway</html>', { status: 200 })) as typeof fetch),
    ).catch((e: unknown) => e);
    expect((err as BinanceApiError).disposition.kind).toBe('uncertain');
  });

  it('220009 日限额 → FAILED 且不重试（§11.4）', async () => {
    const err = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => jsonResponse({ code: '220009', message: 'daily limit' })) as typeof fetch),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceBusinessError);
    expect((err as BinanceApiError).disposition.kind).toBe('fail');
  });

  it('未登记错误码一律 fail（§11.4 末尾保守原则）', async () => {
    const err = await publishShortPost(
      { contentType: 1, bodyTextOnly: 'hi' },
      OPTS((async () => jsonResponse({ code: '999999', message: 'new thing' })) as typeof fetch),
    ).catch((e: unknown) => e);
    expect((err as BinanceApiError).disposition.kind).toBe('fail');
  });

  it('空正文前置校验直接拒绝，不发请求（§11.3 省配额）', async () => {
    let called = false;
    await expect(
      publishShortPost(
        { contentType: 1, bodyTextOnly: '   ' },
        OPTS((async () => { called = true; return jsonResponse(okBody); }) as typeof fetch),
      ),
    ).rejects.toBeInstanceOf(BinanceApiError);
    expect(called).toBe(false);
  });

  it('超过 4 图被拒（§11.2）', async () => {
    await expect(
      publishShortPost(
        {
          contentType: 1,
          bodyTextOnly: 'hi',
          imageList: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4', 'https://a/5'],
        },
        OPTS((async () => jsonResponse(okBody)) as typeof fetch),
      ),
    ).rejects.toBeInstanceOf(BinanceApiError);
  });
});
