/**
 * AES-256-GCM 静态加密（§7.4）。
 *
 * 密文格式：base64( iv(12B) || ciphertext || authTag(16B) )
 * 密钥来源：环境变量 APP_ENCRYPTION_KEY（32 字节，base64 编码）
 *
 * 为什么必须是 GCM 而不是 CBC：GCM 提供认证加密，密文被篡改时解密直接抛错，
 * 避免使用被改写的 Token 发起请求（§7.4）。
 *
 * 必须加密的字段（§7.4，数据库中禁止明文）：
 *   access_token / refresh_token / client_secret / Binance OpenAPI Key / TOTP Secret
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  AES_AUTH_TAG_BYTES,
  AES_IV_BYTES,
  AES_KEY_BYTES,
} from '@x-square/shared';

const ALGORITHM = 'aes-256-gcm';

/** 加密密钥缺失或格式非法时抛出。进程应据此拒绝启动（§7.4）。 */
export class EncryptionKeyError extends Error {
  override readonly name = 'EncryptionKeyError';
}

/** 密文格式非法或被篡改时抛出。 */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

/**
 * 从 base64 字符串解析出 32 字节密钥。
 *
 * @throws EncryptionKeyError 当输入缺失、不是合法 base64、或长度不等于 32 字节
 */
export function parseEncryptionKey(base64Key: string | undefined | null): Buffer {
  if (base64Key === undefined || base64Key === null || base64Key.trim() === '') {
    throw new EncryptionKeyError(
      'APP_ENCRYPTION_KEY 未设置。该密钥用于加密所有 Token 与 API Key，缺失时进程拒绝启动。' +
        '生成方式：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const raw = Buffer.from(base64Key.trim(), 'base64');
  if (raw.length !== AES_KEY_BYTES) {
    throw new EncryptionKeyError(
      `APP_ENCRYPTION_KEY 必须是 ${AES_KEY_BYTES} 字节的 base64 编码` +
        `（AES-256），实际解析得到 ${raw.length} 字节。`,
    );
  }
  return raw;
}

/** 生成一个新的 32 字节密钥，返回 base64 字符串。仅用于初始化与轮换。 */
export function generateEncryptionKey(): string {
  return randomBytes(AES_KEY_BYTES).toString('base64');
}

/**
 * 加密明文。
 *
 * 每次调用都使用新的随机 IV，因此同一明文两次加密的密文不同——这是 GCM 的安全要求，
 * 复用 IV + Key 会彻底破坏机密性与完整性。
 *
 * @param plaintext 明文
 * @param key 32 字节密钥 Buffer（由 parseEncryptionKey 产出）
 * @returns base64( iv || ciphertext || authTag )
 */
export function encrypt(plaintext: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new EncryptionKeyError(`加密密钥必须为 ${AES_KEY_BYTES} 字节的 Buffer。`);
  }

  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

/**
 * 解密密文。
 *
 * @throws DecryptionError 当密文长度不足、base64 非法、或 authTag 校验失败（被篡改）
 */
export function decrypt(encryptedBase64: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new EncryptionKeyError(`解密密钥必须为 ${AES_KEY_BYTES} 字节的 Buffer。`);
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(encryptedBase64, 'base64');
  } catch {
    throw new DecryptionError('密文不是合法的 base64 字符串。');
  }

  const minLength = AES_IV_BYTES + AES_AUTH_TAG_BYTES;
  if (payload.length < minLength) {
    throw new DecryptionError(
      `密文长度不足：至少需要 ${minLength} 字节（IV ${AES_IV_BYTES} + authTag ${AES_AUTH_TAG_BYTES}），` +
        `实际 ${payload.length} 字节。`,
    );
  }

  const iv = payload.subarray(0, AES_IV_BYTES);
  const authTag = payload.subarray(payload.length - AES_AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(AES_IV_BYTES, payload.length - AES_AUTH_TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败：密文被篡改，或使用了错误的密钥
    throw new DecryptionError(
      '解密失败：密文可能被篡改，或 APP_ENCRYPTION_KEY 与加密时不一致。',
    );
  }
}

/** 判断字符串是否「看起来像」本系统产出的密文（长度与 base64 合法性）。 */
export function looksLikeCiphertext(value: string): boolean {
  if (value.length === 0) return false;
  const payload = Buffer.from(value, 'base64');
  return payload.length >= AES_IV_BYTES + AES_AUTH_TAG_BYTES;
}

/**
 * 恒定时间比较两个字符串，用于 Session / CSRF Token 校验，避免时序侧信道。
 *
 * 长度不同时直接返回 false（长度本身不是秘密）。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * 有状态的加解密器，绑定一个固定密钥。
 *
 * 业务代码应通过它而非裸函数调用，避免把 key Buffer 到处传递。
 * 密钥只在构造时校验一次，缺失即抛 EncryptionKeyError（进程拒绝启动，§7.4）。
 */
export class Encryptor {
  private readonly key: Buffer;

  /**
   * @param base64Key APP_ENCRYPTION_KEY 的值；不传则从 process.env 读取
   */
  constructor(base64Key?: string) {
    this.key = parseEncryptionKey(base64Key ?? process.env['APP_ENCRYPTION_KEY']);
  }

  encrypt(plaintext: string): string {
    return encrypt(plaintext, this.key);
  }

  decrypt(encryptedBase64: string): string {
    return decrypt(encryptedBase64, this.key);
  }

  /**
   * 解密并断言结果非空。
   *
   * Token 字段在数据库中是必填列，解出空串意味着数据异常，应当显式失败
   * 而不是拿空 Token 去请求 X / Binance（会退化成难以定位的 401）。
   */
  decryptNonEmpty(encryptedBase64: string, fieldName: string): string {
    const value = this.decrypt(encryptedBase64);
    if (value === '') {
      throw new DecryptionError(`${fieldName} 解密后为空字符串，数据异常。`);
    }
    return value;
  }
}

/**
 * 进程启动时的密钥自检（§7.4：缺失时进程拒绝启动）。
 *
 * 做一次完整的加解密往返，确保密钥不仅格式正确、而且真的可用。
 * 建议在 API / Worker 的启动序列最早期调用。
 *
 * @throws EncryptionKeyError 密钥缺失或格式非法
 * @throws DecryptionError    加解密往返失败（极罕见，通常意味着 Node 加密后端异常）
 */
export function assertEncryptionKeyUsable(base64Key?: string): void {
  const encryptor = new Encryptor(base64Key);
  const probe = `x-square-key-selfcheck-${Date.now()}`;
  const roundTrip = encryptor.decrypt(encryptor.encrypt(probe));
  if (roundTrip !== probe) {
    throw new DecryptionError('APP_ENCRYPTION_KEY 自检失败：加解密往返结果不一致。');
  }
}
