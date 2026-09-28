/**
 * ai 包单测：验证 §15.2 的「强制约束」与「失败降级」。
 */

import { describe, expect, it } from 'vitest';

import type { AIProvider, RewriteInput } from './provider.js';
import { validateRewriteOutput } from './provider.js';
import { rewriteWithFallback } from './registry.js';

const INPUT: RewriteInput = {
  originalText: 'original $BTC post',
  prompt: 'rewrite',
  maxChars: 280,
  lang: 'en',
};

function fakeProvider(overrides: Partial<AIProvider>): AIProvider {
  return {
    name: 'custom',
    rewrite: async () => ({ text: 'rewritten', model: 'm' }),
    healthCheck: async () => true,
    ...overrides,
  } as AIProvider;
}

describe('validateRewriteOutput（§15.2）', () => {
  it('空文本拒绝', () => {
    const result = validateRewriteOutput({ text: '   ', model: 'm' }, 280);
    expect(result.ok).toBe(false);
  });

  it('超长拒绝', () => {
    const long = 'a'.repeat(300);
    const result = validateRewriteOutput({ text: long, model: 'm' }, 280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('超出上限');
  });

  it('结构不合法拒绝', () => {
    expect(validateRewriteOutput({ nope: 1 }, 280).ok).toBe(false);
  });
});

describe('rewriteWithFallback（§15.2 解耦与降级）', () => {
  it('provider 为 null → 原样 + warning', async () => {
    const result = await rewriteWithFallback(INPUT, null);
    expect(result.usedAI).toBe(false);
    expect(result.text).toBe(INPUT.originalText);
    expect(result.warning).toBeTruthy();
  });

  it('healthCheck false → 降级原样', async () => {
    const result = await rewriteWithFallback(
      INPUT,
      fakeProvider({ healthCheck: async () => false }),
    );
    expect(result.usedAI).toBe(false);
    expect(result.text).toBe(INPUT.originalText);
  });

  it('rewrite 抛异常 → 吞掉并降级（核心链路不受影响）', async () => {
    const result = await rewriteWithFallback(
      INPUT,
      fakeProvider({
        rewrite: async () => {
          throw new Error('rate limited by provider');
        },
      }),
    );
    expect(result.usedAI).toBe(false);
    expect(result.warning).toContain('rate limited');
  });

  it('输出校验不过 → 降级原样', async () => {
    const result = await rewriteWithFallback(
      INPUT,
      fakeProvider({ rewrite: async () => ({ text: '', model: 'm' }) }),
    );
    expect(result.usedAI).toBe(false);
  });

  it('成功路径返回改写文本与 model', async () => {
    const result = await rewriteWithFallback(INPUT, fakeProvider({}));
    expect(result.usedAI).toBe(true);
    expect(result.text).toBe('rewritten');
    expect(result.model).toBe('m');
  });
});
