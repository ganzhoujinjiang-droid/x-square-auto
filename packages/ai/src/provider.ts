/**
 * AIProvider 抽象（§15.1）。V1 默认关闭（ai.enabled=false，§15.2）。
 *
 * 本包只定义接口与「校验 + 降级」协议，不实现任何具体 Provider：
 *   - 输出必须经 Zod 校验（非空、长度合规）后才能进入发布（§15.2）；
 *   - AI 调用失败 → 降级为「原样」模式继续任务并记录 warning，绝不阻塞核心链路（§15.2）；
 *   - AI 与 X Monitor 完全解耦：AI 不可用时监控与同步照常运行（§15.2）。
 */

import { z } from 'zod';

/** RewriteInput（§15.1）。 */
export const rewriteInputSchema = z.object({
  originalText: z.string().min(1),
  prompt: z.string().min(1),
  maxChars: z.number().int().positive(),
  lang: z.string().min(1),
  context: z
    .object({
      username: z.string(),
      postedAt: z.string(),
    })
    .optional(),
});
export type RewriteInput = z.infer<typeof rewriteInputSchema>;

/** RewriteOutput（§15.1）。text 的非空与长度由 validateRewriteOutput 强制。 */
export const rewriteOutputSchema = z.object({
  text: z.string(),
  model: z.string(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type RewriteOutput = z.infer<typeof rewriteOutputSchema>;

/** Provider 名称联合（§15.1）。custom 留给自托管网关。 */
export type AIProviderName = 'openai' | 'anthropic' | 'gemini' | 'xai' | 'custom';

/** AIProvider 接口（§15.1）。 */
export interface AIProvider {
  readonly name: AIProviderName;
  rewrite(input: RewriteInput): Promise<RewriteOutput>;
  healthCheck(): Promise<boolean>;
}

/** 校验结果。 */
export type OutputValidation =
  | { ok: true; output: RewriteOutput }
  | { ok: false; reason: string };

/**
 * 强制约束的代码化（§15.2）：非空 + 长度合规。
 *
 * 敏感词检查不在这里做——那是平台侧职责（Binance 20002/20022），
 * 且规则表在 settings 中，属于 process-content Worker 的编排层。
 */
export function validateRewriteOutput(
  raw: unknown,
  maxChars: number,
): OutputValidation {
  const parsed = rewriteOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `AI 输出结构不合法：${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const trimmed = parsed.data.text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'AI 输出为空' };
  }
  if (trimmed.length > maxChars) {
    return { ok: false, reason: `AI 输出 ${trimmed.length} 字符，超出上限 ${maxChars}` };
  }
  return { ok: true, output: { ...parsed.data, text: trimmed } };
}
