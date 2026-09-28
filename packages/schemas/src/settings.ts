/**
 * 同步规则与系统设置的 Zod schema（§17.5、§14）。
 *
 * 这些值存在 settings 表的 Json 列里，读写两侧都必须经 schema 校验，
 * 避免历史脏数据或手工改库导致规则评估行为漂移。
 */

import { z } from 'zod';

import {
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_TEMPLATE,
  POLL_INTERVAL_OPTIONS_SEC,
  TEMPLATE_VARIABLES,
  POST_TYPE,
  SOFT_WARN_CONTENT_LENGTH,
  type PollIntervalSec,
} from '@x-square/shared';

import { nonEmptyStringSchema, strictObject } from './common.js';

/**
 * 轮询间隔校验（§6.2）：只允许 15 / 30 / 60 / 120 / 300 秒。
 *
 * 用 refine 而非字面量联合，是因为档位来自 shared 的常量数组，
 * 单一事实来源可避免两处枚举不同步。
 */
export const pollIntervalSecSchema = z
  .number()
  .int()
  .refine(
    (value): value is PollIntervalSec =>
      (POLL_INTERVAL_OPTIONS_SEC as readonly number[]).includes(value),
    {
      message: `轮询间隔只允许 ${POLL_INTERVAL_OPTIONS_SEC.join(' / ')} 秒（§6.2）`,
    },
  );

// ---------------------------------------------------------------------------
// 帖子类型开关（§17.5）
// ---------------------------------------------------------------------------

/** 各帖子类型是否自动同步。默认策略见 @x-square/shared 的 DEFAULT_SYNC_POLICY。 */
export const postTypeRulesSchema = strictObject({
  original: z.boolean(),
  quote: z.boolean(),
  reply: z.boolean(),
  repost: z.boolean(),
});

export type PostTypeRules = z.infer<typeof postTypeRulesSchema>;

export const DEFAULT_POST_TYPE_RULES: PostTypeRules = {
  original: true,
  quote: false,
  reply: false,
  repost: false,
};

/**
 * 帖子类型键 → JobStatus 判定用的类型名映射。
 *
 * 规则页的四个开关与 §8.1 的四种 postType 一一对应。
 */
export const POST_TYPE_RULE_KEYS = {
  [POST_TYPE.original]: 'original',
  [POST_TYPE.quote]: 'quote',
  [POST_TYPE.reply]: 'reply',
  [POST_TYPE.repost]: 'repost',
} as const;

// ---------------------------------------------------------------------------
// 关键词过滤（§17.5）
// ---------------------------------------------------------------------------

/**
 * 关键词过滤规则。
 *
 * 评估顺序（§17.5）：排除词 → 包含词 → 帖子类型 → 媒体类型。
 * 任一环节不通过即 FILTERED，并记录具体命中的规则名。
 *
 * 排除词优先级高于包含词。包含词留空表示「不按关键词过滤」。
 */
export const keywordRulesSchema = strictObject({
  /** 包含（任一命中即通过，留空表示不过滤） */
  include: z.array(z.string()).default([]),
  /** 排除（任一命中即拦截，优先级高于包含） */
  exclude: z.array(z.string()).default([]),
  /** 是否区分大小写。默认不区分——关键词过滤不应因大小写漏判。 */
  caseSensitive: z.boolean().default(false),
});

export type KeywordRules = z.infer<typeof keywordRulesSchema>;

export const DEFAULT_KEYWORD_RULES: KeywordRules = {
  include: [],
  exclude: [],
  caseSensitive: false,
};

// ---------------------------------------------------------------------------
// 文本处理模式（§14.1）
// ---------------------------------------------------------------------------

/**
 * 文本模式（§14.1）。
 *
 * V1 只有原样与模板化两种可用；ai 模式在 V1 默认关闭（§15.2），
 * 但枚举值保留，使配置结构在 V2 开启 AI 时无需迁移。
 */
export const textModeSchema = z.enum(['raw', 'template', 'ai']);

export type TextMode = z.infer<typeof textModeSchema>;

/**
 * 模板字符串校验（§14.3）。
 *
 * 只允许已登记的变量占位符：{text} {url} {username} {date} {hashtags}。
 * 出现未登记的占位符时拒绝保存——静默保留会让用户以为配置生效了，
 * 实际渲染出的是字面量 "{foo}"。
 */
export const templateSchema = z
  .string()
  .min(1, '模板不得为空')
  .refine((template) => {
    const allowed = new Set<string>(TEMPLATE_VARIABLES);
    for (const match of template.matchAll(/\{(\w+)\}/g)) {
      const key = match[1];
      if (key !== undefined && !allowed.has(key)) {
        return false;
      }
    }
    return true;
  }, {
    message: `模板含有未支持的变量。可用变量：${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(' ')}`,
  });

// ---------------------------------------------------------------------------
// 发布时机（§17.5）
// ---------------------------------------------------------------------------

/**
 * 发布时机。
 *
 *   immediate  立即发布
 *   delay      延迟 1 / 5 / 10 分钟
 *   review     人工审核（进入草稿，等待后台确认）
 *
 * §22.1 将「延迟发布」列入 V1 范围；「人工审核草稿流」在 §22.3 属 V2，
 * 因此 review 模式在 V1 的配置校验中被显式拒绝，避免用户选了却不生效。
 */
export const publishTimingSchema = z.discriminatedUnion('mode', [
  strictObject({ mode: z.literal('immediate') }),
  strictObject({
    mode: z.literal('delay'),
    /** 允许的延迟分钟数，§17.5 */
    minutes: z.union([z.literal(1), z.literal(5), z.literal(10)]),
  }),
]);

export type PublishTiming = z.infer<typeof publishTimingSchema>;

export const DEFAULT_PUBLISH_TIMING: PublishTiming = { mode: 'immediate' };

/** 后台可选的延迟分钟数（§17.5）。 */
export const DELAY_MINUTE_OPTIONS = [1, 5, 10] as const;

// ---------------------------------------------------------------------------
// 完整同步规则
// ---------------------------------------------------------------------------

export const syncRulesSchema = strictObject({
  /** 自动同步总开关（§17.5）。关闭时新帖仍入库，但一律 FILTERED。 */
  enabled: z.boolean(),
  postTypes: postTypeRulesSchema,
  keywords: keywordRulesSchema,
  /** 文本模式，§14.1 */
  textMode: textModeSchema,
  template: templateSchema,
  /** 保留 X 链接（§17.5）。关闭时从模板中移除 {url}。 */
  keepSourceLink: z.boolean(),
  /** 固定标签串，对应模板变量 {hashtags}（§14.3） */
  hashtags: z.string().default(''),
  publishTiming: publishTimingSchema,
  /** 默认发布目标 Binance 账号 ID。V1 单账号。 */
  binanceAccountId: z.string().optional(),
});

export type SyncRules = z.infer<typeof syncRulesSchema>;

export const DEFAULT_SYNC_RULES: SyncRules = {
  enabled: true,
  postTypes: { ...DEFAULT_POST_TYPE_RULES },
  keywords: { ...DEFAULT_KEYWORD_RULES },
  textMode: 'template',
  template: DEFAULT_TEMPLATE,
  keepSourceLink: true,
  hashtags: '',
  publishTiming: { ...DEFAULT_PUBLISH_TIMING },
};

// ---------------------------------------------------------------------------
// 系统设置（非规则部分）
// ---------------------------------------------------------------------------

export const systemSettingsSchema = strictObject({
  /** 轮询间隔秒数，只允许 §6.2 列举的档位 */
  pollIntervalSec: pollIntervalSecSchema.default(DEFAULT_POLL_INTERVAL_SEC),
  /** UI 展示时区，默认 Asia/Tokyo（§20.4） */
  displayTimezone: z.string().default('Asia/Tokyo'),
  /** AI 模块开关，V1 默认 false（§15.2） */
  ai: strictObject({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai', 'anthropic', 'gemini', 'xai', 'custom']).optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxChars: z.number().int().positive().optional(),
  }).default({ enabled: false }),
  /**
   * 正文长度软性预警阈值（§14.3）。
   *
   * ⚠️ 待验证（§26 风险 1）：Square 正文准确上限官方未公开，
   * 实测确认后应更新此配置的默认值。
   */
  contentLengthWarnAt: z.number().int().positive().default(SOFT_WARN_CONTENT_LENGTH),
});

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
  displayTimezone: 'Asia/Tokyo',
  ai: { enabled: false },
  contentLengthWarnAt: SOFT_WARN_CONTENT_LENGTH,
};

/** settings 表中已登记的键名。 */
export const SETTING_KEYS = {
  syncRules: 'sync_rules',
  system: 'system_settings',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// ---------------------------------------------------------------------------
// 后台写操作的请求体（§19.2：拒绝未知字段）
// ---------------------------------------------------------------------------

/** 新增 / 更新 Binance 账号。只接受新密钥，永不回显旧值（§11.6）。 */
export const binanceAccountUpsertSchema = strictObject({
  id: z.string().optional(),
  name: nonEmptyStringSchema,
  /** 明文密钥，仅在请求传输中出现，落库前立即 AES-256-GCM 加密（§7.4） */
  apiKey: z.string().min(1),
});

export type BinanceAccountUpsert = z.infer<typeof binanceAccountUpsertSchema>;

/** 更新 X 账号监控参数。 */
export const xAccountUpdateSchema = strictObject({
  pollIntervalSec: pollIntervalSecSchema.optional(),
  monitoringEnabled: z.boolean().optional(),
});

export type XAccountUpdate = z.infer<typeof xAccountUpdateSchema>;

/**
 * 历史导入请求（§6.5）。
 *
 * 后台提供「导入最近 10 条 / 50 条」，默认不执行；
 * 导入必须逐条经过与自动同步完全相同的规则过滤，且必须在 UI 上二次确认。
 */
export const historyImportSchema = strictObject({
  count: z.union([z.literal(10), z.literal(50)]),
  /** UI 二次确认标记，服务端强制要求为 true，防止误触发批量导入 */
  confirmed: z.literal(true),
});

export type HistoryImport = z.infer<typeof historyImportSchema>;

/** UNCERTAIN 任务的人工处置（§9.2、§17.6）。 */
export const uncertainResolutionSchema = z.discriminatedUnion('action', [
  /** 确认未发布 → 允许重试，回到 QUEUED */
  strictObject({ action: z.literal('retry') }),
  /** 确认已发布 → 标记成功，post_id 允许为空（§9.3 保留官方 skill 语义） */
  strictObject({
    action: z.literal('mark_published'),
    binancePostId: z.string().optional(),
    binancePostUrl: z.string().optional(),
  }),
  /** 放弃该帖 → CANCELLED */
  strictObject({ action: z.literal('cancel') }),
]);

export type UncertainResolution = z.infer<typeof uncertainResolutionSchema>;

/** 图片处理失败后的人工降级选择（§12）。不允许自动降级为纯文字发布。 */
export const mediaFailureResolutionSchema = z.discriminatedUnion('action', [
  /** 仅发布文字：去掉 imageList 重新入队 */
  strictObject({ action: z.literal('text_only') }),
  /** 放弃该帖 */
  strictObject({ action: z.literal('cancel') }),
  /** 手动重试 */
  strictObject({ action: z.literal('retry') }),
]);

export type MediaFailureResolution = z.infer<typeof mediaFailureResolutionSchema>;

/** 登录请求（§19.1）。 */
export const loginRequestSchema = strictObject({
  username: nonEmptyStringSchema,
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 修改密码请求（§19.1：首次登录强制修改）。 */
export const changePasswordRequestSchema = strictObject({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, '新密码至少 12 位'),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
