/**
 * 队列载荷 schema 测试（§10.1、§10.4）。
 *
 * 任务经 Redis 序列化后跨进程传递，类型信息丢失，Worker 消费前必须重新校验。
 * 崩溃恢复（§10.4）后重新分配的任务若字段残缺，可能带着错误参数去调用 Binance。
 */

import { describe, expect, it } from 'vitest';

import {
  QUEUE_PAYLOAD_SCHEMAS,
  downloadMediaPayloadSchema,
  nowIso,
  parseQueuePayload,
  processContentPayloadSchema,
  publishBinancePayloadSchema,
  syncPostPayloadSchema,
  uploadMediaPayloadSchema,
} from './queue.js';

const BASE = {
  syncJobId: 'cku1abc2def3ghi4jkl5mno',
  xPostId: '1834567890123456789',
  enqueuedAt: '2026-09-27T12:30:00.000Z',
};

describe('sync-post 载荷（§10.1）', () => {
  it('解析合法载荷', () => {
    const parsed = syncPostPayloadSchema.parse({ ...BASE, xAccountId: 'acct_1' });
    expect(parsed.xAccountId).toBe('acct_1');
  });

  it('拒绝缺失 syncJobId 的载荷', () => {
    const { syncJobId: _omitted, ...rest } = BASE;
    expect(syncPostPayloadSchema.safeParse({ ...rest, xAccountId: 'a' }).success).toBe(false);
  });

  it('拒绝非 Snowflake 的 xPostId', () => {
    expect(
      syncPostPayloadSchema.safeParse({ ...BASE, xPostId: 'not-a-snowflake', xAccountId: 'a' })
        .success,
    ).toBe(false);
  });

  it('严格模式：拒绝未登记字段', () => {
    expect(
      syncPostPayloadSchema.safeParse({ ...BASE, xAccountId: 'a', rules: {} }).success,
    ).toBe(false);
  });
});

describe('process-content 载荷（§15.2 降级需改写载荷重试）', () => {
  it('接受三种文本模式', () => {
    for (const textMode of ['raw', 'template', 'ai'] as const) {
      expect(
        processContentPayloadSchema.safeParse({ ...BASE, textMode }).success,
      ).toBe(true);
    }
  });

  it('拒绝未登记的模式', () => {
    expect(
      processContentPayloadSchema.safeParse({ ...BASE, textMode: 'translate' }).success,
    ).toBe(false);
  });
});

describe('download-media 载荷（§12）', () => {
  it('保留附件顺序 index（决定 imageList 顺序）', () => {
    const parsed = downloadMediaPayloadSchema.parse({
      ...BASE,
      sourceUrl: 'https://pbs.twimg.com/media/abc.jpg',
      mediaKey: '3_1834567890',
      index: 2,
    });
    expect(parsed.index).toBe(2);
  });

  it('拒绝非 URL 的 sourceUrl', () => {
    expect(
      downloadMediaPayloadSchema.safeParse({
        ...BASE,
        sourceUrl: 'ftp://invalid',
        mediaKey: 'k',
        index: 0,
      }).success,
    ).toBe(false);
  });

  it('拒绝负数 index', () => {
    expect(
      downloadMediaPayloadSchema.safeParse({
        ...BASE,
        sourceUrl: 'https://pbs.twimg.com/media/a.jpg',
        mediaKey: 'k',
        index: -1,
      }).success,
    ).toBe(false);
  });
});

describe('upload-media 载荷（§11.1 / §11.3）', () => {
  it('携带本地路径、文件名与序号', () => {
    const parsed = uploadMediaPayloadSchema.parse({
      ...BASE,
      localPath: '/tmp/x-square-media/cku1_0.jpg',
      fileName: 'cku1_0.jpg',
      index: 0,
      binanceAccountId: 'acct_1',
    });
    expect(parsed.localPath).toContain('/tmp/x-square-media');
  });

  it('拒绝空文件名', () => {
    expect(
      uploadMediaPayloadSchema.safeParse({
        ...BASE,
        localPath: '/tmp/x/a.jpg',
        fileName: '',
        index: 0,
        binanceAccountId: 'acct_1',
      }).success,
    ).toBe(false);
  });
});

describe('publish-binance 载荷（§9.3 危险区 / §9.4 幂等键）', () => {
  const VALID = {
    ...BASE,
    binanceAccountId: 'acct_1',
    idempotencyKey: 'a'.repeat(64),
    bodyTextOnly: 'BTC breaks resistance',
  };

  it('解析纯文本发布载荷', () => {
    expect(publishBinancePayloadSchema.parse(VALID).bodyTextOnly).toBe('BTC breaks resistance');
  });

  it('allowUncertain 缺省时补为 true（禁止自动重试的显式声明）', () => {
    expect(publishBinancePayloadSchema.parse(VALID).allowUncertain).toBe(true);
  });

  it('拒绝 allowUncertain = false（不允许绕过 UNCERTAIN 机制）', () => {
    expect(
      publishBinancePayloadSchema.safeParse({ ...VALID, allowUncertain: false }).success,
    ).toBe(false);
  });

  it('拒绝空正文（对应 Binance 20020 / 220011）', () => {
    expect(
      publishBinancePayloadSchema.safeParse({ ...VALID, bodyTextOnly: '' }).success,
    ).toBe(false);
  });

  it('接受 4 张图、拒绝 5 张（§11.2 短帖上限）', () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://img.example.com/${i}.png`);
    expect(
      publishBinancePayloadSchema.safeParse({ ...VALID, imageList: urls(4) }).success,
    ).toBe(true);
    expect(
      publishBinancePayloadSchema.safeParse({ ...VALID, imageList: urls(5) }).success,
    ).toBe(false);
  });

  it('拒绝缺失幂等键（§9.4 的第二道防线不能省略）', () => {
    const { idempotencyKey: _omitted, ...rest } = VALID;
    expect(publishBinancePayloadSchema.safeParse(rest).success).toBe(false);
  });
});

describe('parseQueuePayload 与队列名映射', () => {
  it('覆盖 §10.1 定义的全部 6 条队列', () => {
    expect(Object.keys(QUEUE_PAYLOAD_SCHEMAS).sort()).toEqual(
      [
        'download-media',
        'process-content',
        'publish-binance',
        'reconcile-uncertain',
        'sync-post',
        'upload-media',
      ].sort(),
    );
  });

  it('按队列名解析对应载荷', () => {
    const parsed = parseQueuePayload('sync-post', { ...BASE, xAccountId: 'acct_1' });
    expect(parsed.xAccountId).toBe('acct_1');
  });

  it('载荷与队列名不匹配时抛 ZodError', () => {
    expect(() => parseQueuePayload('sync-post', { ...BASE, localPath: '/tmp/a' })).toThrow();
  });

  it('非法载荷抛出可被 Worker 捕获的错误', () => {
    expect(() => parseQueuePayload('publish-binance', null)).toThrow();
  });
});

describe('nowIso', () => {
  it('产出 UTC ISO 字符串（§20.4）', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
