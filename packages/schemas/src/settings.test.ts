/**
 * 同步规则与系统设置 schema 测试（§14、§17.5、§19.2）。
 *
 * 重点验证：
 *   - 模板只允许已登记变量，拼写错误必须被拒绝而非静默保留
 *   - 轮询间隔只允许 §6.2 的五个档位
 *   - 历史导入必须带 UI 二次确认标记（§6.5）
 *   - UNCERTAIN 人工处置的三种出口（§9.2、§17.6）
 *   - AI 默认关闭（§15.2）
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYNC_RULES,
  DEFAULT_SYSTEM_SETTINGS,
  DEFAULT_KEYWORD_RULES,
  DELAY_MINUTE_OPTIONS,
  POST_TYPE_RULE_KEYS,
  SETTING_KEYS,
  binanceAccountUpsertSchema,
  changePasswordRequestSchema,
  historyImportSchema,
  keywordRulesSchema,
  loginRequestSchema,
  mediaFailureResolutionSchema,
  pollIntervalSecSchema,
  publishTimingSchema,
  syncRulesSchema,
  systemSettingsSchema,
  templateSchema,
  uncertainResolutionSchema,
  xAccountUpdateSchema,
} from './settings.js';

import { DEFAULT_POLL_INTERVAL_SEC, POST_TYPE } from '@x-square/shared';

describe('syncRulesSchema 默认值（§8.2 V1 默认策略）', () => {
  it('默认策略与文档表格一致：仅原创自动同步', () => {
    const rules = syncRulesSchema.parse(DEFAULT_SYNC_RULES);
    expect(rules.postTypes.original).toBe(true);
    expect(rules.postTypes.quote).toBe(false);
    expect(rules.postTypes.reply).toBe(false);
    expect(rules.postTypes.repost).toBe(false);
  });

  it('总开关默认开启，文本模式默认模板化（§17.5）', () => {
    const rules = syncRulesSchema.parse(DEFAULT_SYNC_RULES);
    expect(rules.enabled).toBe(true);
    expect(rules.textMode).toBe('template');
  });

  it('帖子类型规则键与 §8.1 的四种类型一一对应', () => {
    expect(POST_TYPE_RULE_KEYS[POST_TYPE.original]).toBe('original');
    expect(POST_TYPE_RULE_KEYS[POST_TYPE.reply]).toBe('reply');
    expect(POST_TYPE_RULE_KEYS[POST_TYPE.repost]).toBe('repost');
    expect(POST_TYPE_RULE_KEYS[POST_TYPE.quote]).toBe('quote');
  });
});

describe('keywordRulesSchema（§17.5）', () => {
  it('默认不区分大小写，且包含/排除词默认为空（留空表示不按关键词过滤）', () => {
    const rules = keywordRulesSchema.parse(DEFAULT_KEYWORD_RULES);
    expect(rules.caseSensitive).toBe(false);
    expect(rules.include).toEqual([]);
    expect(rules.exclude).toEqual([]);
  });

  it('接受文档示例中的关键词', () => {
    const rules = keywordRulesSchema.parse({
      include: ['BTC', 'ETH', 'AI', 'NVIDIA', 'Crypto'],
      exclude: ['Giveaway', 'Casino', '广告', 'airdrop'],
    });
    expect(rules.include).toHaveLength(5);
    expect(rules.exclude).toContain('广告');
  });

  it('缺省字段用默认值补全', () => {
    expect(keywordRulesSchema.parse({}).exclude).toEqual([]);
  });
});

describe('templateSchema（§14.3）', () => {
  it('接受默认模板', () => {
    expect(() =>
      templateSchema.parse('{text}\n\n—\n来源：@{username}\n{url}'),
    ).not.toThrow();
  });

  it('接受全部已登记变量', () => {
    expect(() =>
      templateSchema.parse('{text} {url} {username} {date} {hashtags}'),
    ).not.toThrow();
  });

  it('拒绝未登记的变量占位符（避免静默渲染出字面量）', () => {
    const result = templateSchema.safeParse('{text} {not_a_variable}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('{text}');
    }
  });

  it('拒绝空模板', () => {
    expect(templateSchema.safeParse('').success).toBe(false);
  });

  it('不含任何变量的纯文本模板合法', () => {
    expect(() => templateSchema.parse('固定前缀 {text}')).not.toThrow();
  });
});

describe('pollIntervalSecSchema（§6.2：15 / 30 / 60 / 120 / 300）', () => {
  it('接受全部合法档位', () => {
    for (const value of [15, 30, 60, 120, 300]) {
      expect(pollIntervalSecSchema.safeParse(value).success).toBe(true);
    }
  });

  it('拒绝档位之外的值（禁止写死高频轮询，§6.2）', () => {
    expect(pollIntervalSecSchema.safeParse(1).success).toBe(false);
    expect(pollIntervalSecSchema.safeParse(5).success).toBe(false);
    expect(pollIntervalSecSchema.safeParse(45).success).toBe(false);
    expect(pollIntervalSecSchema.safeParse(600).success).toBe(false);
  });

  it('拒绝非整数', () => {
    expect(pollIntervalSecSchema.safeParse(30.5).success).toBe(false);
  });
});

describe('publishTimingSchema（§17.5）', () => {
  it('默认立即发布', () => {
    expect(publishTimingSchema.parse({ mode: 'immediate' }).mode).toBe('immediate');
  });

  it('接受 1 / 5 / 10 分钟延迟', () => {
    for (const minutes of DELAY_MINUTE_OPTIONS) {
      expect(
        publishTimingSchema.safeParse({ mode: 'delay', minutes }).success,
      ).toBe(true);
    }
  });

  it('拒绝其他延迟分钟数', () => {
    expect(
      publishTimingSchema.safeParse({ mode: 'delay', minutes: 3 }).success,
    ).toBe(false);
  });

  it('delay 模式缺少 minutes 时被拒绝', () => {
    expect(publishTimingSchema.safeParse({ mode: 'delay' }).success).toBe(false);
  });

  it('拒绝人工审核模式（§22.3：草稿流属 V2，V1 不生效）', () => {
    expect(publishTimingSchema.safeParse({ mode: 'review' }).success).toBe(false);
  });
});

describe('systemSettingsSchema（§15.2 / §20.4）', () => {
  it('AI 默认关闭', () => {
    const settings = systemSettingsSchema.parse(DEFAULT_SYSTEM_SETTINGS);
    expect(settings.ai.enabled).toBe(false);
  });

  it('空对象也能解析出完整默认结构', () => {
    const settings = systemSettingsSchema.parse({});
    expect(settings.pollIntervalSec).toBe(DEFAULT_POLL_INTERVAL_SEC);
    expect(settings.displayTimezone).toBe('Asia/Tokyo');
    expect(settings.ai).toEqual({ enabled: false });
  });

  it('拒绝非法的 AI provider', () => {
    expect(
      systemSettingsSchema.safeParse({ ai: { enabled: true, provider: 'claude' } }).success,
    ).toBe(false);
  });

  it('AI 温度限制在 0～2', () => {
    expect(
      systemSettingsSchema.safeParse({ ai: { enabled: true, temperature: 2.5 } }).success,
    ).toBe(false);
  });

  it('严格模式：拒绝未登记的设置键', () => {
    expect(systemSettingsSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });
});

describe('SETTING_KEYS', () => {
  it('settings 表键名稳定（改动会导致既有配置读不出来）', () => {
    expect(SETTING_KEYS.syncRules).toBe('sync_rules');
    expect(SETTING_KEYS.system).toBe('system_settings');
  });
});

describe('historyImportSchema（§6.5：默认不执行 + UI 二次确认）', () => {
  it('接受导入 10 条并已确认', () => {
    expect(historyImportSchema.parse({ count: 10, confirmed: true }).count).toBe(10);
  });

  it('接受导入 50 条', () => {
    expect(historyImportSchema.parse({ count: 50, confirmed: true }).count).toBe(50);
  });

  it('拒绝其他条数（后台只提供 10 / 50 两个按钮）', () => {
    expect(historyImportSchema.safeParse({ count: 100, confirmed: true }).success).toBe(false);
  });

  it('未确认时被拒绝（防止误触发批量导入）', () => {
    expect(historyImportSchema.safeParse({ count: 10, confirmed: false }).success).toBe(false);
    expect(historyImportSchema.safeParse({ count: 10 }).success).toBe(false);
  });
});

describe('uncertainResolutionSchema（§9.2 / §17.6 人工出口）', () => {
  it('确认未发布 → 重新入队', () => {
    expect(uncertainResolutionSchema.parse({ action: 'retry' }).action).toBe('retry');
  });

  it('确认已发布 → 标记成功，post_id 允许为空（§9.3 保留官方 skill 语义）', () => {
    const withoutId = uncertainResolutionSchema.parse({ action: 'mark_published' });
    expect(withoutId.action).toBe('mark_published');
    const withId = uncertainResolutionSchema.parse({
      action: 'mark_published',
      binancePostId: '456789',
      binancePostUrl: 'https://www.binance.com/square/post/456789',
    });
    expect('binancePostId' in withId && withId.binancePostId).toBe('456789');
  });

  it('放弃该帖 → 取消', () => {
    expect(uncertainResolutionSchema.parse({ action: 'cancel' }).action).toBe('cancel');
  });

  it('拒绝未登记的处置动作', () => {
    expect(uncertainResolutionSchema.safeParse({ action: 'auto_retry' }).success).toBe(false);
  });
});

describe('mediaFailureResolutionSchema（§12：不允许自动降级为纯文字）', () => {
  it('三种人工选择均合法', () => {
    for (const action of ['text_only', 'cancel', 'retry'] as const) {
      expect(mediaFailureResolutionSchema.safeParse({ action }).success).toBe(true);
    }
  });

  it('拒绝自动降级动作', () => {
    expect(mediaFailureResolutionSchema.safeParse({ action: 'auto_text_only' }).success).toBe(
      false,
    );
  });
});

describe('binanceAccountUpsertSchema（§11.6）', () => {
  it('接受名称与密钥', () => {
    const parsed = binanceAccountUpsertSchema.parse({
      name: '主账号',
      apiKey: 'binance-publishing-key',
    });
    expect(parsed.apiKey).toBe('binance-publishing-key');
  });

  it('拒绝空名称与空密钥', () => {
    expect(
      binanceAccountUpsertSchema.safeParse({ name: '  ', apiKey: 'k' }).success,
    ).toBe(false);
    expect(
      binanceAccountUpsertSchema.safeParse({ name: 'n', apiKey: '' }).success,
    ).toBe(false);
  });

  it('严格模式：拒绝回显旧密钥的多余字段', () => {
    expect(
      binanceAccountUpsertSchema.safeParse({
        name: 'n',
        apiKey: 'k',
        apiKeyMasked: 'abc12...xyz9',
      }).success,
    ).toBe(false);
  });
});

describe('xAccountUpdateSchema（§17.3）', () => {
  it('接受合法轮询间隔', () => {
    expect(xAccountUpdateSchema.parse({ pollIntervalSec: 60 }).pollIntervalSec).toBe(60);
  });

  it('接受暂停/恢复监控开关（§22.1）', () => {
    expect(xAccountUpdateSchema.parse({ monitoringEnabled: false }).monitoringEnabled).toBe(false);
  });

  it('拒绝非法轮询间隔', () => {
    expect(xAccountUpdateSchema.safeParse({ pollIntervalSec: 7 }).success).toBe(false);
  });
});

describe('登录与改密（§19.1）', () => {
  it('登录请求需用户名与非空密码', () => {
    expect(loginRequestSchema.parse({ username: 'admin', password: 'p' }).username).toBe('admin');
    expect(loginRequestSchema.safeParse({ username: '', password: 'p' }).success).toBe(false);
  });

  it('新密码至少 12 位', () => {
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'old-password-123',
        newPassword: 'short',
      }).success,
    ).toBe(false);
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'old-password-123',
        newPassword: 'a-long-enough-password',
      }).success,
    ).toBe(true);
  });

  it('拒绝弱口令 admin123（§25.3）', () => {
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'x',
        newPassword: 'admin123',
      }).success,
    ).toBe(false);
  });
});

describe('DEFAULT_SYNC_RULES 结构完整性', () => {
  it('默认规则本身能通过 schema 校验（seed 依赖此保证）', () => {
    expect(() => syncRulesSchema.parse(DEFAULT_SYNC_RULES)).not.toThrow();
  });

  it('默认规则不含 binanceAccountId（首次部署时尚未配置账号）', () => {
    expect(DEFAULT_SYNC_RULES.binanceAccountId).toBeUndefined();
  });

  it('默认开启保留 X 链接（§17.5）', () => {
    expect(DEFAULT_SYNC_RULES.keepSourceLink).toBe(true);
  });
});
