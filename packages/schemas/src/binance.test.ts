/**
 * Binance Square OpenAPI schema 测试（§11.1、§11.2）。
 *
 * 重点验证三个最容易踩的坑：
 *   1. 成功判定必须是字符串 "000000"，不能写成 code == 0
 *   2. 正文字段名是 bodyTextOnly，图片列表是 imageList，封面 cover 是单个字符串
 *   3. 短帖最多 4 张图，文章模式不能带 imageList
 */

import { describe, expect, it } from 'vitest';

import { BINANCE_SUCCESS_CODE } from '@x-square/shared';

import {
  articlePostRequestSchema,
  contentAddDataSchema,
  contentAddRequestSchema,
  imageStatusDataSchema,
  isBinanceSuccess,
  parsePublishOutcome,
  presignedUrlDataSchema,
  shortPostRequestSchema,
  validateShortPost,
} from './binance.js';

describe('成功判定（§11.1：code 是字符串 "000000"）', () => {
  it('字符串 "000000" 判定为成功', () => {
    expect(isBinanceSuccess({ code: BINANCE_SUCCESS_CODE })).toBe(true);
    expect(isBinanceSuccess({ code: '000000' })).toBe(true);
  });

  it('其他 code 一律判为失败，包括形似的 "000001" 与 "0"', () => {
    expect(isBinanceSuccess({ code: '000001' })).toBe(false);
    expect(isBinanceSuccess({ code: '0' })).toBe(false);
    expect(isBinanceSuccess({ code: '220009' })).toBe(false);
  });

  it('数字 0 不会被误判为成功（类型层面即拒绝）', () => {
    // 若写成 code == 0，字符串 "000000" 与数字 0 会被混为一谈
    expect(isBinanceSuccess({ code: 0 as unknown as string })).toBe(false);
  });
});

describe('presignedUrl 响应（§11.1 端点一）', () => {
  it('解析 presignedUrl 与 fileTicket', () => {
    const parsed = presignedUrlDataSchema.parse({
      presignedUrl: 'https://binance-cdn.example.com/upload?sig=abc',
      fileTicket: 'ticket_123',
    });
    expect(parsed.fileTicket).toBe('ticket_123');
  });

  it('拒绝非 URL 的 presignedUrl', () => {
    expect(() =>
      presignedUrlDataSchema.parse({ presignedUrl: 'not-a-url', fileTicket: 't' }),
    ).toThrow();
  });

  it('拒绝空 fileTicket', () => {
    expect(() =>
      presignedUrlDataSchema.parse({
        presignedUrl: 'https://cdn.example.com/u',
        fileTicket: '',
      }),
    ).toThrow();
  });
});

describe('imageStatus 响应（§11.1 端点二）', () => {
  it('status = 1 表示处理完成并带 imageUrl', () => {
    const parsed = imageStatusDataSchema.parse({
      status: 1,
      imageUrl: 'https://binance.example.com/img/abc.png',
    });
    expect(parsed.status).toBe(1);
    expect(parsed.imageUrl).toBeDefined();
  });

  it('status = 2 表示失败并带 failedReason', () => {
    const parsed = imageStatusDataSchema.parse({ status: 2, failedReason: '格式不支持' });
    expect(parsed.status).toBe(2);
    expect(parsed.failedReason).toBe('格式不支持');
  });

  it('status = 0 表示处理中，imageUrl 可缺省', () => {
    expect(imageStatusDataSchema.parse({ status: 0 }).status).toBe(0);
  });

  it('接受未列举的中间态（官方描述为「其他（如 0）」，继续轮询）', () => {
    expect(() => imageStatusDataSchema.parse({ status: 3 })).not.toThrow();
  });
});

describe('短帖请求体（§11.1 端点三 / §11.2）', () => {
  it('字段名必须是 bodyTextOnly 而非 content / text', () => {
    const parsed = shortPostRequestSchema.parse({
      contentType: 1,
      bodyTextOnly: 'BTC breaks resistance $BTC #crypto',
    });
    expect(parsed.bodyTextOnly).toContain('$BTC');
  });

  it('拒绝错误的字段名 content', () => {
    expect(() =>
      shortPostRequestSchema.parse({ contentType: 1, content: '正文' }),
    ).toThrow();
  });

  it('$BTC 与 #topic 原样保留，不被转义（§14.2）', () => {
    const text = '$BTC #crypto 涨了 5%';
    expect(shortPostRequestSchema.parse({ contentType: 1, bodyTextOnly: text }).bodyTextOnly).toBe(
      text,
    );
  });

  it('接受 4 张图（短帖上限，§11.2）', () => {
    const parsed = shortPostRequestSchema.parse({
      contentType: 1,
      bodyTextOnly: '四图帖',
      imageList: [
        'https://img.example.com/1.png',
        'https://img.example.com/2.png',
        'https://img.example.com/3.png',
        'https://img.example.com/4.png',
      ],
    });
    expect(parsed.imageList).toHaveLength(4);
  });

  it('拒绝 5 张图', () => {
    expect(() =>
      shortPostRequestSchema.parse({
        contentType: 1,
        bodyTextOnly: '五图帖',
        imageList: Array.from({ length: 5 }, (_, i) => `https://img.example.com/${i}.png`),
      }),
    ).toThrow(/最多 4 张/);
  });

  it('拒绝空正文（对应错误码 20020 / 220011）', () => {
    expect(() =>
      shortPostRequestSchema.parse({ contentType: 1, bodyTextOnly: '' }),
    ).toThrow();
  });

  it('短帖模式不接受 title / cover（§11.2 图片与文章互斥）', () => {
    expect(() =>
      shortPostRequestSchema.parse({
        contentType: 1,
        bodyTextOnly: '正文',
        title: '标题',
      }),
    ).toThrow();
  });
});

describe('长文章请求体（§11.1，V1 不实现但 schema 先登记）', () => {
  it('需要 title，cover 为单个 URL 字符串而非数组', () => {
    const parsed = articlePostRequestSchema.parse({
      contentType: 2,
      bodyTextOnly: '文章正文…',
      title: 'Market Report',
      cover: 'https://img.example.com/cover.png',
    });
    expect(parsed.title).toBe('Market Report');
    expect(typeof parsed.cover).toBe('string');
  });

  it('拒绝 cover 为数组（§11.1 明确 cover 是单个 URL 字符串）', () => {
    expect(() =>
      articlePostRequestSchema.parse({
        contentType: 2,
        bodyTextOnly: '正文',
        title: '标题',
        cover: ['https://img.example.com/a.png'],
      }),
    ).toThrow();
  });

  it('文章模式不能传 imageList（§11.2）', () => {
    expect(() =>
      articlePostRequestSchema.parse({
        contentType: 2,
        bodyTextOnly: '正文',
        title: '标题',
        imageList: ['https://img.example.com/a.png'],
      }),
    ).toThrow();
  });
});

describe('contentAddRequestSchema 判别联合', () => {
  it('按 contentType 正确路由到短帖分支', () => {
    const parsed = contentAddRequestSchema.parse({
      contentType: 1,
      bodyTextOnly: '短帖',
      imageList: ['https://img.example.com/1.png'],
    });
    expect(parsed.contentType).toBe(1);
  });

  it('按 contentType 正确路由到文章分支', () => {
    const parsed = contentAddRequestSchema.parse({
      contentType: 2,
      bodyTextOnly: '文章',
      title: '标题',
    });
    expect(parsed.contentType).toBe(2);
  });

  it('拒绝未登记的 contentType（V1 不支持视频帖）', () => {
    expect(() =>
      contentAddRequestSchema.parse({ contentType: 3, bodyTextOnly: '视频帖' }),
    ).toThrow();
  });
});

describe('validateShortPost（§11.3：发出前前置校验，避免浪费日配额）', () => {
  it('合法请求返回空违规列表', () => {
    expect(
      validateShortPost({ contentType: 1, bodyTextOnly: '正常正文' }),
    ).toEqual([]);
  });

  it('纯空白正文被判违规（对应 20020 / 220011）', () => {
    expect(
      validateShortPost({ contentType: 1, bodyTextOnly: '   \n  ' }),
    ).toContain('正文为空（对应错误码 20020 / 220011）');
  });

  it('超过 4 张图被判违规', () => {
    const violations = validateShortPost({
      contentType: 1,
      bodyTextOnly: '正文',
      imageList: Array.from({ length: 5 }, (_, i) => `https://img.example.com/${i}.png`),
    });
    expect(violations.some((v) => v.includes('最多 4 张'))).toBe(true);
  });
});

describe('parsePublishOutcome（§11.1 的 504 特判 / §9.3 的本系统决策）', () => {
  it('有 id 时为 published_with_id', () => {
    const result = parsePublishOutcome({
      id: '456789',
      shareLink: 'https://www.binance.com/square/post/456789',
    });
    expect(result.outcome).toBe('published_with_id');
    expect(result.postId).toBe('456789');
    expect(result.postUrl).toContain('/square/post/');
  });

  it('数字 id 被归一化为字符串', () => {
    expect(parsePublishOutcome({ id: 456789 }).postId).toBe('456789');
  });

  it('成功但无 id 时为 published_without_id（官方 skill 的 504 语义）', () => {
    const result = parsePublishOutcome({});
    expect(result.outcome).toBe('published_without_id');
    expect(result.postId).toBeNull();
  });

  it('data 缺省时同样为 published_without_id', () => {
    expect(parsePublishOutcome(undefined).outcome).toBe('published_without_id');
  });

  it('contentAddDataSchema 解析官方示例响应', () => {
    const parsed = contentAddDataSchema.parse({
      id: '123456',
      shareLink: 'https://www.binance.com/square/post/123456',
    });
    expect(parsed.id).toBe('123456');
  });
});
