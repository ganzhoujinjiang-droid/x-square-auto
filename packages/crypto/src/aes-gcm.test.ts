/**
 * Phase 1 验收测试：加解密往返（§23 Phase 1「加解密往返测试通过」）。
 */

import { describe, expect, it } from 'vitest';

import { AES_AUTH_TAG_BYTES, AES_IV_BYTES, AES_KEY_BYTES } from '@x-square/shared';

import {
  DecryptionError,
  Encryptor,
  EncryptionKeyError,
  assertEncryptionKeyUsable,
  decrypt,
  encrypt,
  generateEncryptionKey,
  looksLikeCiphertext,
  parseEncryptionKey,
  safeEqual,
} from './aes-gcm.js';

/** 生成一个合法的 32 字节 base64 密钥，避免测试依赖环境变量。 */
function testKey(): string {
  return generateEncryptionKey();
}

describe('parseEncryptionKey', () => {
  it('接受 32 字节 base64 密钥', () => {
    const key = parseEncryptionKey(testKey());
    expect(key).toHaveLength(AES_KEY_BYTES);
  });

  it('密钥缺失时抛错并提示生成方式（§7.4：缺失时进程拒绝启动）', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('   ')).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it('长度不是 32 字节时抛错', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => parseEncryptionKey(short)).toThrow(/32 字节/);
  });
});

describe('加解密往返', () => {
  it('普通文本往返一致', () => {
    const key = parseEncryptionKey(testKey());
    const plaintext = 'x-access-token-sample-value';
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('空字符串可正常往返', () => {
    const key = parseEncryptionKey(testKey());
    expect(decrypt(encrypt('', key), key)).toBe('');
  });

  it('多字节中文与 emoji 往返一致', () => {
    const key = parseEncryptionKey(testKey());
    const plaintext = '币安广场同步 🚀 密钥测试';
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('长文本（4KB）往返一致', () => {
    const key = parseEncryptionKey(testKey());
    const plaintext = 'a'.repeat(4096);
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('密文长度为 IV + 明文 + authTag', () => {
    const key = parseEncryptionKey(testKey());
    const plaintext = 'twelve-chars';
    const payload = Buffer.from(encrypt(plaintext, key), 'base64');
    expect(payload).toHaveLength(
      AES_IV_BYTES + Buffer.byteLength(plaintext, 'utf8') + AES_AUTH_TAG_BYTES,
    );
  });

  it('同一明文两次加密产生不同密文（IV 随机，GCM 安全要求）', () => {
    const key = parseEncryptionKey(testKey());
    const plaintext = 'same-input';
    expect(encrypt(plaintext, key)).not.toBe(encrypt(plaintext, key));
  });
});

describe('GCM 认证：密文被篡改必须失败（§7.4）', () => {
  it('翻转密文中的一个比特后解密抛错', () => {
    const key = parseEncryptionKey(testKey());
    const payload = Buffer.from(encrypt('sensitive-token', key), 'base64');

    // 篡改 IV 之后、authTag 之前的密文区
    const targetIndex = AES_IV_BYTES;
    payload[targetIndex] = (payload[targetIndex] ?? 0) ^ 0xff;

    expect(() => decrypt(payload.toString('base64'), key)).toThrow(DecryptionError);
  });

  it('篡改 authTag 后解密抛错', () => {
    const key = parseEncryptionKey(testKey());
    const payload = Buffer.from(encrypt('sensitive-token', key), 'base64');

    const lastIndex = payload.length - 1;
    payload[lastIndex] = (payload[lastIndex] ?? 0) ^ 0x01;

    expect(() => decrypt(payload.toString('base64'), key)).toThrow(DecryptionError);
  });

  it('用错误的密钥解密抛错', () => {
    const ciphertext = encrypt('token-a', parseEncryptionKey(testKey()));
    expect(() => decrypt(ciphertext, parseEncryptionKey(testKey()))).toThrow(DecryptionError);
  });

  it('密文长度不足时抛错', () => {
    const key = parseEncryptionKey(testKey());
    const tooShort = Buffer.alloc(AES_IV_BYTES + AES_AUTH_TAG_BYTES - 1).toString('base64');
    expect(() => decrypt(tooShort, key)).toThrow(/长度不足/);
  });
});

describe('Encryptor', () => {
  it('绑定密钥后往返一致', () => {
    const encryptor = new Encryptor(testKey());
    expect(encryptor.decrypt(encryptor.encrypt('binance-api-key'))).toBe('binance-api-key');
  });

  it('decryptNonEmpty 拒绝空结果', () => {
    const encryptor = new Encryptor(testKey());
    const emptyCiphertext = encryptor.encrypt('');
    expect(() => encryptor.decryptNonEmpty(emptyCiphertext, 'access_token')).toThrow(
      /access_token/,
    );
  });

  it('密钥长度非法时构造即抛错', () => {
    expect(() => new Encryptor(Buffer.alloc(8).toString('base64'))).toThrow(
      EncryptionKeyError,
    );
  });
});

describe('assertEncryptionKeyUsable', () => {
  it('合法密钥自检通过', () => {
    expect(() => assertEncryptionKeyUsable(testKey())).not.toThrow();
  });

  it('缺失密钥自检抛错', () => {
    expect(() => assertEncryptionKeyUsable('')).toThrow(EncryptionKeyError);
  });
});

describe('looksLikeCiphertext', () => {
  it('真实密文判定为 true', () => {
    const key = parseEncryptionKey(testKey());
    expect(looksLikeCiphertext(encrypt('x', key))).toBe(true);
  });

  it('明文字符串判定为 false', () => {
    // 明文密钥若被误存入库，应能被识别出来（§7.4 禁止明文存储）
    expect(looksLikeCiphertext('plaintext-api-key')).toBe(false);
    expect(looksLikeCiphertext('')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('相同字符串返回 true', () => {
    expect(safeEqual('csrf-token-value', 'csrf-token-value')).toBe(true);
  });

  it('不同字符串返回 false', () => {
    expect(safeEqual('csrf-token-value', 'csrf-token-valuE')).toBe(false);
  });

  it('长度不同返回 false', () => {
    expect(safeEqual('short', 'a-much-longer-string')).toBe(false);
  });
});
