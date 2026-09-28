/**
 * 后台认证：Argon2id 登录 + Session + CSRF + Rate Limit + 失败锁定（§19.1、§19.2）。
 *
 * Session 存 Redis（服务端态，可吊销），Cookie HttpOnly + SameSite=Lax + Secure(prod)。
 * 失败锁定：同 IP+用户名连续 LOGIN_MAX_FAILURES 次失败 → 锁 LOGIN_LOCK_DURATION_MS。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword, safeEqual, loginFailureKey, generateSessionId } from '@x-square/crypto';
import { prisma } from '@x-square/database';
import { LOG_REDACT_PATHS, LOGIN_LOCK_DURATION_MS, LOGIN_MAX_FAILURES } from '@x-square/shared';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyRequest {
    session: (SessionData & { sessionId: string }) | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    csrfGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const SESSION_TTL_SEC = 8 * 60 * 60; // 8 小时工作会话
const SESSION_PREFIX = 'session:';

export interface SessionData {
  userId: string;
  username: string;
  csrfToken: string;
}

/** Pino redact 路径（§7.6 日志红线）：任何级别不得输出凭据。 */
export const LOGGER_REDACT_PATHS = [
  ...LOG_REDACT_PATHS,
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
] as const;

export function sessionKey(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

/** 读取并校验会话；无效返回 null。 */
export async function readSession(redis: Redis, sessionId: string | undefined): Promise<(SessionData & { sessionId: string }) | null> {
  if (!sessionId) return null;
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return { ...(JSON.parse(raw) as SessionData), sessionId };
  } catch {
    return null;
  }
}

/** requireAuth / csrfGuard 的具体实现（供 registerAuth 装饰与路由直接引用）。 */
export function makeRequireAuth(redis: Redis) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.session) {
      await reply.code(401).send({ error: 'UNAUTHENTICATED' });
      throw new Error('fastify.internal.abort'); // 阻断后续 handler（Fastify 官方推荐模式）
    }
  };
}

export function makeCsrfGuard() {
  return async function csrfGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const header = request.headers['x-csrf-token'];
    if (!request.session || typeof header !== 'string' || !safeEqual(header, request.session.csrfToken)) {
      await reply.code(403).send({ error: 'CSRF_FAILED' });
      throw new Error('fastify.internal.abort');
    }
  };
}

/** 注册认证插件：decorate auth / requireAuth / csrfGuard。 */
export function registerAuth(app: FastifyInstance, redis: Redis): void {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const cookie = request.cookies?.['xsq_session'];
    const session = await readSession(redis, typeof cookie === 'string' ? cookie : undefined);
    if (session) request.session = session;
  });

  app.decorate('requireAuth', makeRequireAuth(redis));
  /**
   * 写操作 CSRF 双提交校验：请求头 x-csrf-token 必须与会话内 token 一致。
   * 读操作（GET/HEAD）不校验——本系统 API 从不以 HTML 形式渲染敏感状态。
   */
  app.decorate('csrfGuard', makeCsrfGuard());
}

/** 登录成功：创建服务端会话并轮换 CSRF Token。 */
export async function createSession(redis: Redis, user: { id: string; username: string }): Promise<{ sessionId: string; data: SessionData }> {
  const sessionId = generateSessionId();
  const data: SessionData = { userId: user.id, username: user.username, csrfToken: generateSessionId() };
  await redis.set(sessionKey(sessionId), JSON.stringify(data), 'EX', SESSION_TTL_SEC);
  return { sessionId, data };
}

export async function destroySession(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(sessionKey(sessionId));
}

/**
 * 密码校验 + 失败锁定（§19.1）。
 *
 * @returns 'ok' | 'bad-credentials' | { lockedForMs }
 */
export async function verifyLogin(
  redis: Redis,
  ip: string,
  username: string,
  password: string,
): Promise<'ok' | 'bad-credentials' | 'locked'> {
  const key = loginFailureKey(ip, username);
  const failuresRaw = await redis.get(key);
  const failures = failuresRaw === null ? 0 : Number(failuresRaw);
  if (failures >= LOGIN_MAX_FAILURES) return 'locked';

  const user = await prisma.adminUser.findUnique({ where: { username } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    const next = failures + 1;
    await redis.set(key, String(next), 'PX', LOGIN_LOCK_DURATION_MS);
    return 'bad-credentials';
  }
  await redis.del(key);
  return 'ok';
}

/** 修改密码后重哈希（§19.1 首次登录强制改密）。 */
export async function changePassword(userId: string, newPassword: string): Promise<string> {
  const hash = await hashPassword(newPassword);
  await prisma.adminUser.update({
    where: { id: userId },
    data: { passwordHash: hash, mustChangePassword: false },
  });
  return hash;
}
