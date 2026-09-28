/**
 * 环境变量与启动校验（§7.4 / §19.4）。
 *
 * APP_ENCRYPTION_KEY 缺失或格式错误时进程拒绝启动——半配置状态运行
 * 会导致「Token 写入后永远解不开」的不可恢复事故。
 */

import { assertEncryptionKeyUsable } from '@x-square/crypto';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  apiPort: number;
  apiBaseUrl: string;
  encryptionKeyBase64: string;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  xClientId: string;
  xClientSecret?: string;
  xRedirectUri: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const require = (name: string): string => {
    const value = env[name];
    if (!value || value.trim() === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const config: AppConfig = {
    nodeEnv: (env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    apiPort: Number(env.API_PORT ?? 4000),
    apiBaseUrl: env.API_BASE_URL ?? 'http://127.0.0.1:4000',
    encryptionKeyBase64: require('APP_ENCRYPTION_KEY'),
    databaseUrl: require('DATABASE_URL'),
    redisUrl: require('REDIS_URL'),
    sessionSecret: require('SESSION_SECRET'),
    xClientId: require('X_CLIENT_ID'),
    ...(env.X_CLIENT_SECRET ? { xClientSecret: env.X_CLIENT_SECRET } : {}),
    xRedirectUri: env.X_REDIRECT_URI ?? 'http://127.0.0.1:4000/api/x/oauth/callback',
    logLevel: env.LOG_LEVEL ?? 'info',
  };

  if (missing.length > 0) {
    throw new Error(`缺少必需环境变量：${missing.join(', ')}（参照 .env.example）`);
  }
  // AES-256-GCM 密钥必须为 32 字节 base64，否则拒绝启动（§7.4）
  assertEncryptionKeyUsable(config.encryptionKeyBase64);
  if (config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET 至少 32 字节随机字符串（§19.2）');
  }
  return config;
}
