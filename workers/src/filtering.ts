/**
 * 规则过滤引擎（§8.2、§17.5）。
 *
 * sync-post Worker 的第一步：对 DISCOVERED 任务评估是否同步。
 * 命中任何拒绝条件 → FILTERED（终态，非错误），filterReason 记录命中项，
 * 让「为什么这条没同步」在详情页可查（§17.4）。
 *
 * 评估顺序按 §17.5：排除词 → 包含词 → 帖子类型 → 媒体类型。
 * 纯函数设计：不碰数据库与队列，便于单测穷举组合。
 */

import type { KeywordRules, PostTypeRules } from '@x-square/schemas';
import { DEFAULT_KEYWORD_RULES, DEFAULT_POST_TYPE_RULES, POST_TYPE_RULE_KEYS } from '@x-square/schemas';
import {
  BINANCE_SHORT_POST_MAX_IMAGES,
  detectMediaKind,
  MEDIA_MAX_BYTES,
  POST_TYPE,
  SOFT_WARN_CONTENT_LENGTH,
  VIDEO_UNSUPPORTED_REASON,
  type PostType,
} from '@x-square/shared';

/** 参与判定的最小帖子视图（从 x_posts 行提取）。 */
export interface FilterablePost {
  postType: PostType;
  text: string;
  /** media_json 中的媒体类型列表（photo/video/animated_gif）。 */
  mediaTypes: string[];
  /** photo 数量（决定 imageList 长度）。 */
  photoCount: number;
}

/** 判定结果。 */
export type FilterDecision =
  | { sync: true; contentLengthWarn: boolean }
  | { sync: false; reason: string };

/** 关键词匹配（§17.5）：默认大小写不敏感的子串包含。 */
function containsAny(text: string, keywords: readonly string[], caseSensitive: boolean): string | null {
  const haystack = caseSensitive ? text : text.toLowerCase();
  for (const keyword of keywords) {
    if (keyword.length === 0) continue;
    const needle = caseSensitive ? keyword : keyword.toLowerCase();
    if (haystack.includes(needle)) return keyword;
  }
  return null;
}

/**
 * 评估一条帖子是否进入同步。
 *
 * 「明确不做」的项（视频/GIF）不受用户开关影响（§8.2 V1 不开放）。
 */
export function evaluateSyncRules(
  post: FilterablePost,
  rules: {
    postTypes?: Partial<PostTypeRules>;
    keywords?: Partial<KeywordRules>;
  } = {},
): FilterDecision {
  const typeRules: PostTypeRules = { ...DEFAULT_POST_TYPE_RULES, ...rules.postTypes };
  const keywordRules: KeywordRules = { ...DEFAULT_KEYWORD_RULES, ...rules.keywords };
  const cs = keywordRules.caseSensitive ?? false;

  // 1. 排除词一票否决（§17.5：优先级高于包含词）
  const excluded = containsAny(post.text, keywordRules.exclude ?? [], cs);
  if (excluded !== null) {
    return { sync: false, reason: `命中排除关键词「${excluded}」` };
  }

  // 2. 包含词：配置了 include 时必须命中其一；留空表示不按关键词过滤
  const includes = keywordRules.include ?? [];
  if (includes.length > 0 && containsAny(post.text, includes, cs) === null) {
    return { sync: false, reason: '未命中任何包含关键词' };
  }

  // 3. 帖子类型开关（原创默认开；Reply/Repost/Quote 默认关且 UI 有风险提示 §8.2）
  const ruleKey = POST_TYPE_RULE_KEYS[post.postType];
  if (!typeRules[ruleKey]) {
    return { sync: false, reason: `帖子类型 ${post.postType} 未开启同步` };
  }

  // 4. 含视频 / GIF → V1 一律不同步（§8.2「V1 不开放」）
  const mediaKind = detectMediaKind(post.mediaTypes);
  if (mediaKind === 'video') {
    return { sync: false, reason: VIDEO_UNSUPPORTED_REASON };
  }

  // 5. 图片数量超上限（§11.2 最多 4 张）
  if (post.photoCount > BINANCE_SHORT_POST_MAX_IMAGES) {
    return {
      sync: false,
      reason: `图片 ${post.photoCount} 张，超过 Binance 上限 ${BINANCE_SHORT_POST_MAX_IMAGES}`,
    };
  }

  // 通过全部规则；正文软预警（§14.3 的 280 字符黄字提示，不拦截）
  return {
    sync: true,
    contentLengthWarn: post.text.length > SOFT_WARN_CONTENT_LENGTH,
  };
}

/** 媒体大小前置校验（§12 ≤15MB），供 download-media 之后调用。 */
export function checkMediaSize(bytes: number): { ok: boolean; reason?: string } {
  if (bytes > MEDIA_MAX_BYTES) {
    return { ok: false, reason: `图片 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 15MB 上限` };
  }
  if (bytes === 0) {
    return { ok: false, reason: '图片为空文件' };
  }
  return { ok: true };
}
