/**
 * Provider 注册表与降级执行（§15.2）。
 *
 * V1 没有任何内置 Provider 实现——注册表默认为空，ai.enabled=false。
 * process-content Worker 通过 rewriteWithFallback 调用：
 *   - AI 未启用 / 未注册 / healthCheck 失败 / 输出校验不过 → 返回原样文本并带 warning；
 *   - 核心链路（监控、同步、发布）绝不因 AI 故障中断。
 */

import type { AIProvider, RewriteInput } from './provider.js';
import { validateRewriteOutput } from './provider.js';

export type AIRegistry = Partial<Record<AIProvider['name'], AIProvider>>;

/** 改写结果：either 改写文本或降级原文，附 warning。 */
export interface RewriteResult {
  /** 最终进入发布的文本。 */
  text: string;
  /** 是否走了 AI 路径。 */
  usedAI: boolean;
  /** 降级原因（usedAI=false 时有值），供日志 warning（§15.2）。 */
  warning?: string;
  model?: string;
}

/**
 * 「尝试 AI，失败降级原样」的唯一入口。
 *
 * @param provider null/undefined 代表 AI 关闭（V1 默认）
 */
export async function rewriteWithFallback(
  input: RewriteInput,
  provider: AIProvider | null | undefined,
): Promise<RewriteResult> {
  if (!provider) {
    return { text: input.originalText, usedAI: false, warning: 'AI 未启用，按原样模式处理' };
  }

  try {
    const healthy = await provider.healthCheck();
    if (!healthy) {
      return { text: input.originalText, usedAI: false, warning: `${provider.name} healthCheck 未通过，降级原样` };
    }
    const output = await provider.rewrite(input);
    const validated = validateRewriteOutput(output, input.maxChars);
    if (!validated.ok) {
      return { text: input.originalText, usedAI: false, warning: `${validated.reason}，降级原样` };
    }
    return { text: validated.output.text, usedAI: true, model: validated.output.model };
  } catch (error) {
    // 任何异常都不冒泡——AI 是旁路能力（§15.2「AI 与 X Monitor 完全解耦」）
    const reason = error instanceof Error ? error.message : String(error);
    return { text: input.originalText, usedAI: false, warning: `AI 调用异常（${reason}），降级原样` };
  }
}
