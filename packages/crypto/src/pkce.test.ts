/**
 * PKCE 测试（§7.1）。
 *
 * RFC 7636 对 code_challenge 的定义：BASE64URL(SHA256(ASCII(code_verifier)))。
 * 这里用规范附录 B 的官方测试向量验证实现正确性。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CODE_CHALLENGE_METHOD,
  computeCodeChallenge,
  generateCodeVerifier,
  generateCsrfToken,
  generatePkcePair,
  generateSessionId,
  generateState,
  isValidCodeVerifier,
  loginFailureKey,
  toBase64Url,
} from './pkce.js';

/** RFC 7636 附录 B 官方测试向量。 */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('computeCodeChallenge', () => {
  it('符合 RFC 7636 附录 B 官方测试向量', () => {
    expect(computeCodeChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  it('结果不含 base64 padding 与 +/ 字符', () => {
    const challenge = computeCodeChallenge(generateCodeVerifier());
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('与手工 SHA256 + base64url 计算一致', () => {
    const verifier = generateCodeVerifier();
    const expected = toBase64Url(
      createHash('sha256').update(verifier, 'ascii').digest(),
    );
    expect(computeCodeChallenge(verifier)).toBe(expected);
  });
});

describe('generateCodeVerifier', () => {
  it('长度落在 RFC 7636 要求的 43～128 字符区间', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('通过 isValidCodeVerifier 校验', () => {
    expect(isValidCodeVerifier(generateCodeVerifier())).toBe(true);
  });

  it('每次生成不同值', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe('isValidCodeVerifier', () => {
  it('拒绝过短的 verifier', () => {
    expect(isValidCodeVerifier('too-short')).toBe(false);
  });

  it('拒绝含非法字符的 verifier', () => {
    expect(isValidCodeVerifier(`${'a'.repeat(20)} ${'b'.repeat(30)}`)).toBe(false);
  });

  it('接受官方测试向量', () => {
    expect(isValidCodeVerifier(RFC7636_VERIFIER)).toBe(true);
  });
});

describe('generateState', () => {
  it('32 字节随机的 base64url 形式（§7.1）', () => {
    const state = generateState();
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    expect(state).not.toMatch(/[+/=]/);
  });

  it('每次生成不同值', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe('generatePkcePair', () => {
  it('一次产出 state / verifier / challenge，且 challenge 与 verifier 匹配', () => {
    const pair = generatePkcePair();
    expect(pair.state).toBeTruthy();
    expect(isValidCodeVerifier(pair.codeVerifier)).toBe(true);
    expect(pair.codeChallenge).toBe(computeCodeChallenge(pair.codeVerifier));
    expect(pair.codeChallengeMethod).toBe(CODE_CHALLENGE_METHOD);
  });
});

describe('会话与限流键', () => {
  it('generateSessionId 产出 UUID', () => {
    expect(generateSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generateCsrfToken 每次不同', () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });

  it('loginFailureKey 按 IP + 小写用户名组合（§19.1）', () => {
    expect(loginFailureKey('1.2.3.4', 'Admin')).toBe('login:fail:1.2.3.4:admin');
  });
});
