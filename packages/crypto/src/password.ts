/**
 * 后台登录口令哈希（§19.1）。
 *
 * 算法：Argon2id，参数下限
 *   memory      ≥ 64MB
 *   iterations  ≥ 3
 *   parallelism = 1
 *
 * 实现选择 @node-rs/argon2 而非 argon2（§26 风险 9）：
 * 部署目标是 ARM64 的 Oracle 免费实例，宿主机无 gcc / make / node，
 * 原生模块必须在容器内针对 arm64 编译。@node-rs/argon2 提供 arm64 预编译二进制，
 * 可避免在 Docker builder 阶段引入完整编译工具链。
 */

import { hash as argon2Hash, verify as argon2Verify, Version } from '@node-rs/argon2';

import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
} from '@x-square/shared';

/** Argon2id 参数，按 §19.1 的下限取值。 */
const ARGON2_OPTIONS = {
  /** 内存开销，单位 KiB。64MB = 65536 KiB。 */
  memoryCost: ARGON2_MEMORY_KIB,
  /** 迭代次数（time cost）。 */
  timeCost: ARGON2_TIME_COST,
  /** 并行度。§19.1 要求为 1，避免多核环境下的时序差异。 */
  parallelism: ARGON2_PARALLELISM,
  version: Version.V0x13,
} as const;

/**
 * 最小口令长度。
 *
 * §19.1 未给出具体数值，但初始管理员密码由 seed 从环境变量读取（§25.3 明确禁止
 * admin123 之类弱口令），且 changePasswordRequestSchema 要求新密码至少 12 位，
 * 此处与之保持一致。
 */
export const MIN_PASSWORD_LENGTH = 12;

/** 口令过短错误。 */
export class WeakPasswordError extends Error {
  override readonly name = 'WeakPasswordError';
}

/**
 * 哈希口令。
 *
 * @throws WeakPasswordError 口令长度不足 MIN_PASSWORD_LENGTH
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  return argon2Hash(password, ARGON2_OPTIONS);
}

/** 校验口令。哈希格式非法时返回 false 而非抛错，避免登录接口 500。 */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 判断哈希是否为本系统产出的 Argon2id 格式。 */
export function isArgon2idHash(value: string): boolean {
  return value.startsWith('$argon2id$');
}

/**
 * 判断是否需要重新哈希（参数已升级或哈希格式过期）。
 *
 * 用于登录成功后透明升级旧哈希，避免批量重置口令。
 */
export function needsRehash(passwordHash: string): boolean {
  if (!isArgon2idHash(passwordHash)) {
    return true;
  }
  // $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>
  const params = passwordHash.split('$')[3];
  if (!params) {
    return true;
  }
  const parsed = Object.fromEntries(
    params.split(',').map((pair) => {
      const [key, value] = pair.split('=');
      return [key, Number(value)];
    }),
  );
  return (
    parsed['m'] !== ARGON2_MEMORY_KIB ||
    parsed['t'] !== ARGON2_TIME_COST ||
    parsed['p'] !== ARGON2_PARALLELISM
  );
}

function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `口令至少 ${MIN_PASSWORD_LENGTH} 位，当前 ${password.length} 位（§19.1）。`,
    );
  }
}
