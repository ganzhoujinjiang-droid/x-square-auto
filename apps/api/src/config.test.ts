/**
 * apps/api 配置与认证纯逻辑单测（不依赖数据库/Redis）。
 */

import { describe, expect, it } from 'vitest';
import { generateEncryptionKey } from '@x-square/crypto';

import { loadConfig } from './config.js';

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  APP_ENCRYPTION_KEY: generateEncryptionKey(),
  DATABASE_URL: 'postgresql://x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a'.repeat(32),
  X_CLIENT_ID: 'client-1',
});

describe('loadConfig（§7.4 / §19.4）', () => {
  it('完整环境正常加载', () => {
    const config = loadConfig(validEnv());
    expect(config.xClientId).toBe('client-1');
    expect(config.apiPort).toBe(4000);
  });

  it('缺少必需变量时拒绝启动并列出全部缺失项', () => {
    const env = validEnv();
    delete env.APP_ENCRYPTION_KEY;
    delete env.SESSION_SECRET;
    expect(() => loadConfig(env)).toThrow(/APP_ENCRYPTION_KEY.*SESSION_SECRET|SESSION_SECRET.*APP_ENCRYPTION_KEY/);
  });

  it('加密密钥格式非法直接拒绝（§7.4）', () => {
    const env = validEnv();
    env.APP_ENCRYPTION_KEY = 'not-a-valid-key';
    expect(() => loadConfig(env)).toThrow();
  });

  it('SESSION_SECRET 短于 32 字节拒绝（§19.2）', () => {
    const env = validEnv();
    env.SESSION_SECRET = 'short';
    expect(() => loadConfig(env)).toThrow(/SESSION_SECRET/);
  });
});
