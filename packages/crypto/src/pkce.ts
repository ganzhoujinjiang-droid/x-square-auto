/**
 * PKCE 与随机凭据生成（§7.1）。
 *
 * OAuth 2.0 Authorization Code + PKCE 流程中，客户端侧需要生成：
 *   - state：32 字节随机，存 Redis，TTL 10 分钟，一次性用后即删
 *   - code_verifier：43～128 字符随机
 *   - code_challenge：BASE64URL(SHA256(verifier))
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * code_verifier 的长度（字符数）。
 *
 * RFC 7636 要求 43～128 字符，取 64 字节随机数经 base64url 编码后为 86 字符，
 * 落在合法区间中上部，熵充足。
 */
const CODE_VERIFIER_RANDOM_BYTES = 64;

/** state 的长度：32 字节随机（§7.1）。 */
const STATE_RANDOM_BYTES = 32;

/** base64url 编码：去掉 padding，替换 +/ 为 -_。 */
function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 生成 OAuth state（32 字节随机的 base64url 形式，§7.1）。 */
export function generateState(): string {
  return toBase64Url(randomBytes(STATE_RANDOM_BYTES));
}

/** 生成 PKCE code_verifier（§7.1：43～128 字符随机）。 */
export function generateCodeVerifier(): string {
  return toBase64Url(randomBytes(CODE_VERIFIER_RANDOM_BYTES));
}

/**
 * 由 code_verifier 计算 code_challenge（§7.1）：
 *
 *   code_challenge = BASE64URL(SHA256(code_verifier))
 *
 * 注意 SHA256 的输入是 verifier 的 ASCII 字节，而非其 base64url 解码结果。
 */
export function computeCodeChallenge(codeVerifier: string): string {
  const digest = createHash('sha256').update(codeVerifier, 'ascii').digest();
  return toBase64Url(digest);
}

/** X 授权页固定使用的 code_challenge_method（§7.1）。 */
export const CODE_CHALLENGE_METHOD = 'S256';

/**
 * 生成一次完整的 PKCE 参数对。
 *
 * 调用方应把 verifier 与 state 一起存入 Redis（键见 @x-square/shared 的
 * pkceVerifierKey / oauthStateKey），回调时取出并立即删除（一次性，§7.1）。
 */
export function generatePkcePair(): {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof CODE_CHALLENGE_METHOD;
} {
  const codeVerifier = generateCodeVerifier();
  return {
    state: generateState(),
    codeVerifier,
    codeChallenge: computeCodeChallenge(codeVerifier),
    codeChallengeMethod: CODE_CHALLENGE_METHOD,
  };
}

/** 校验 code_verifier 是否符合 RFC 7636 的长度与字符集要求。 */
export function isValidCodeVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(value);
}

/** 生成 Session ID。使用 UUIDv4，其内部即为 122 位随机。 */
export function generateSessionId(): string {
  return randomUUID();
}

/** 生成 CSRF Token（§19.2：同步器 Token 模式）。 */
export function generateCsrfToken(): string {
  return toBase64Url(randomBytes(32));
}

/** 生成登录失败锁定 / 限流计数用的复合键（§19.1：同 IP + 同用户名）。 */
export function loginFailureKey(ip: string, username: string): string {
  return `login:fail:${ip}:${username.toLowerCase()}`;
}

export { toBase64Url };
