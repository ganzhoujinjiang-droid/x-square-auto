/**
 * 数据库初始化种子（§19.1、§25.3）。
 *
 * 创建初始管理员账号 + 写入默认同步规则与系统设置。
 *
 * 安全要求（§25.3）：默认管理员密码必须来自环境变量，绝不能是 "admin123"。
 * 密码缺失时直接报错退出，不生成任何弱口令兜底值。
 *
 * 运行：pnpm db:seed
 */

import { hashPassword } from '@x-square/crypto';
import { disconnectPrisma, prisma } from '@x-square/database';
import {
  DEFAULT_SYNC_RULES,
  DEFAULT_SYSTEM_SETTINGS,
  SETTING_KEYS,
  syncRulesSchema,
  systemSettingsSchema,
} from '@x-square/schemas';

/** 读取必需的环境变量，缺失时报错并给出明确的补救指引。 */
function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`环境变量 ${name} 未设置。${hint}`);
  }
  return value;
}

async function seedAdminUser(): Promise<void> {
  const username = requireEnv(
    'ADMIN_USERNAME',
    '请在 .env 中设置后台管理员用户名。',
  );
  const password = requireEnv(
    'ADMIN_PASSWORD',
    '请在 .env 中设置后台管理员初始密码（至少 12 位）。' +
      '出于安全考虑，本脚本不提供任何默认口令（§25.3）。',
  );

  // 幂等：重复执行 seed 不应报唯一约束冲突，也不应把已修改过的密码重置回环境变量值。
  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`[seed] 管理员 ${username} 已存在，跳过创建。`);
    return;
  }

  const passwordHash = await hashPassword(password);

  await prisma.adminUser.create({
    data: {
      username,
      passwordHash,
      // §19.1：首次登录强制修改密码
      mustChangePassword: true,
    },
  });

  console.log(`[seed] 已创建管理员 ${username}（首次登录需修改密码）。`);
}

/**
 * 写入默认设置。
 *
 * upsert 前先经 Zod 校验：settings 表是 Json 列，若直接写入未经校验的对象，
 * 后续读取时 parse 会失败，导致规则页整页不可用。
 */
async function seedSettings(): Promise<void> {
  const syncRules = syncRulesSchema.parse(DEFAULT_SYNC_RULES);
  const systemSettings = systemSettingsSchema.parse(DEFAULT_SYSTEM_SETTINGS);

  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.syncRules },
    update: { value: syncRules as object },
    create: { key: SETTING_KEYS.syncRules, value: syncRules as object },
  });

  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.system },
    update: { value: systemSettings as object },
    create: { key: SETTING_KEYS.system, value: systemSettings as object },
  });

  console.log('[seed] 已写入默认同步规则与系统设置。');
}

/**
 * 校验 APP_ENCRYPTION_KEY 是否已配置。
 *
 * seed 本身不加密任何数据，但 API / Worker 启动时会因该密钥缺失而拒绝启动（§7.4）。
 * 在此提前提示，避免用户 seed 完成后才发现服务起不来。
 */
function warnIfEncryptionKeyMissing(): void {
  if (process.env['APP_ENCRYPTION_KEY']?.trim()) {
    return;
  }
  console.warn(
    '[seed] ⚠️ APP_ENCRYPTION_KEY 未设置。API 与 Worker 进程将拒绝启动（§7.4）。\n' +
      "       生成方式：node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      '       ⚠️ 该密钥丢失将导致所有已保存的 Token 与 API Key 永久无法解密，请离线备份。',
  );
}

async function main(): Promise<void> {
  console.log('[seed] 开始初始化数据库…');
  warnIfEncryptionKeyMissing();
  await seedAdminUser();
  await seedSettings();
  console.log('[seed] 完成。');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
