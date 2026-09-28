/**
 * 通用工具函数。
 */

import { createHash } from 'node:crypto';

import {
  SECRET_MASK_PREFIX_LEN,
  SECRET_MASK_SUFFIX_LEN,
  TEMPLATE_VARIABLES,
  type TemplateVariable,
} from './constants.js';

/**
 * 生成幂等键（§9.4）：
 *
 *   idempotency_key = sha256(x_post_id + binance_account_id + content_hash)
 *
 * 发布前先查该键：若已存在 SUCCESS 记录则直接跳过。这是防止 UNCERTAIN 人工重试
 * 造成重复发布的第二道防线（第一道是 PUBLISHING 前置状态校验，§10.4）。
 *
 * 各字段之间插入 \u0000 分隔，避免 ("a","bc") 与 ("ab","c") 产生相同摘要。
 */
export function buildIdempotencyKey(params: {
  xPostId: string;
  binanceAccountId: string;
  contentHash: string;
}): string {
  const payload = [
    params.xPostId,
    params.binanceAccountId,
    params.contentHash,
  ].join('\u0000');
  return sha256Hex(payload);
}

/** 计算内容的 sha256 十六进制摘要，用于幂等键与变更检测。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 密钥掩码（§11.6）：前 5 位 + ... + 后 4 位，例如 abc12...xyz9。
 *
 * 后台 API 永不返回完整密钥，只返回掩码。短于「前缀 + 后缀 + 2」的密钥
 * 整体掩码，避免小样本泄露全部内容。
 */
export function maskSecret(secret: string): string {
  const minRevealedLength = SECRET_MASK_PREFIX_LEN + SECRET_MASK_SUFFIX_LEN + 2;
  if (secret.length < minRevealedLength) {
    return '****';
  }
  const prefix = secret.slice(0, SECRET_MASK_PREFIX_LEN);
  const suffix = secret.slice(-SECRET_MASK_SUFFIX_LEN);
  return `${prefix}...${suffix}`;
}

/**
 * UTC 日键，格式 yyyymmdd。
 *
 * §20.4 的强制要求：Binance 日限额（100 帖 / 400 上传）与 X 的 24h 去重窗口
 * 都按 UTC 日计算，因此 Redis 计数器键必须用 UTC 日期，不能用本地时区日期——
 * 否则会出现「后台显示还有额度但 API 报 220009」的诡异问题。
 */
export function utcDayKey(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Binance 配额计数键（§11.3）：binance:{accountId}:post_count:{yyyymmdd}
 *
 * @param kind post_count 或 upload_count
 */
export function binanceQuotaKey(
  accountId: string,
  kind: 'post_count' | 'upload_count',
  date: Date = new Date(),
): string {
  return `binance:${accountId}:${kind}:${utcDayKey(date)}`;
}

/** OAuth state 的 Redis 键。state 为 32 字节随机、一次性、用后即删（§7.1）。 */
export function oauthStateKey(state: string): string {
  return `x:oauth:state:${state}`;
}

/** PKCE code_verifier 的 Redis 键（§7.1）。 */
export function pkceVerifierKey(state: string): string {
  return `x:oauth:pkce:${state}`;
}

/** X 账号轮询分布式锁键，防止多实例重复轮询（§6.4）。 */
export function pollLockKey(xAccountId: string): string {
  return `x:poll:lock:${xAccountId}`;
}

/**
 * 渲染文本模板（§14.3）。
 *
 * 支持变量：{text} {url} {username} {date} {hashtags}
 *
 * ⚠️ 不做任何转义：$BTC 与 #topic 由 Binance 服务端解析成 cashtag/hashtag，
 * 客户端原样传递即可（§14.2）。
 *
 * 未识别的占位符原样保留，便于用户发现拼写错误，而不是静默产出空串。
 */
export function renderTemplate(
  template: string,
  variables: Partial<Record<TemplateVariable, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(key)) {
      return match;
    }
    const value = variables[key as TemplateVariable];
    return value ?? match;
  });
}

/**
 * 提取模板中实际使用到的变量名，供后台 UI 校验与提示。
 */
export function extractTemplateVariables(template: string): TemplateVariable[] {
  const found = new Set<TemplateVariable>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const key = match[1];
    if (key && (TEMPLATE_VARIABLES as readonly string[]).includes(key)) {
      found.add(key as TemplateVariable);
    }
  }
  return [...found];
}

/**
 * 从文件名或 URL 推断扩展名（小写，不含点）。
 *
 * 用于图片上传时的 Content-Type 映射（§11.1）。URL 可能带查询串，需先剥离。
 */
export function extractExtension(nameOrUrl: string): string | null {
  const withoutQuery = nameOrUrl.split('?')[0] ?? '';
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return null;
  }
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/**
 * 按 ISO 格式（UTC）输出时间戳，用于日志与 {date} 变量。
 *
 * §20.4：应用层全部 UTC；UI 展示层再按用户设置时区转换。
 */
export function toUtcIsoString(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * 截断长字符串用于日志摘要，避免日志体积膨胀。
 *
 * @param maxLength 截断后总长度上限（含省略号）
 */
export function truncateForLog(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.max(0, maxLength - 1);
  return `${text.slice(0, keep)}…`;
}

/**
 * 日志脱敏路径（§7.6）。
 *
 * 任何级别的日志都禁止输出这些字段。交给 Pino 的 redact 选项使用。
 * 覆盖：X Token、Binance Key、Cookie、Session、加密主密钥、Authorization 头。
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'access_token_encrypted',
  'refresh_token_encrypted',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'client_secret',
  'clientSecret',
  'api_key',
  'apiKey',
  'api_key_encrypted',
  'apiKeyEncrypted',
  'X-Square-OpenAPI-Key',
  'x-square-openapi-key',
  'totp_secret_encrypted',
  'totpSecretEncrypted',
  'password',
  'passwordHash',
  'password_hash',
  'cookie',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'sessionId',
  'session_id',
  'APP_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.Authorization',
];

/** Pino redact 的替换值，明确标注为已脱敏而非留空（§7.6）。 */
export const LOG_REDACT_CENSOR = '[REDACTED]';
