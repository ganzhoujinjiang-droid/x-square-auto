/**
 * Fastify API 服务入口（§5 apps/api、§19）。
 *
 * 安全头与限流在注册路由前挂好：
 *   - helmet 类头由 onSend 钩子补齐（不引额外依赖）；
 *   - @fastify/rate-limit 全局 API_RATE_LIMIT_PER_MIN，登录端点单独收紧（§19.2）；
 *   - Pino redact 覆盖凭据路径（§7.6），生产 info 级。
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { Encryptor, MIN_PASSWORD_LENGTH, WeakPasswordError } from '@x-square/crypto';
import { createBullConnection } from '@x-square/queue';
import { prisma, checkDatabaseHealth, disconnectPrisma } from '@x-square/database';
import { API_RATE_LIMIT_PER_MIN, LOGIN_RATE_LIMIT_PER_MIN } from '@x-square/shared';

import { loadConfig } from './config.js';
import {
  LOGGER_REDACT_PATHS,
  registerAuth,
  verifyLogin,
  createSession,
  destroySession,
  changePassword,
} from './auth.js';
import { registerXOAuthRoutes } from './routes/x-oauth.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' },
    },
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, {
    global: true,
    max: API_RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
  });

  // 安全响应头（§19.2）：CSP 限制脚本来源，frame-ancestors none 防点击劫持
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    );
    if (config.nodeEnv === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  const redis = new Redis(config.redisUrl);
  const bullConnection = createBullConnection(config.redisUrl);
  const encryptor = new Encryptor(config.encryptionKeyBase64);

  registerAuth(app, redis);

  // 登录端点独立更严的限流（§19.1 / §19.2）
  app.post(
    '/api/login',
    {
      config: { rateLimit: { max: LOGIN_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { username, password } = request.body as { username?: string; password?: string };
      if (!username || !password) return reply.code(400).send({ error: 'BAD_REQUEST' });
      const result = await verifyLogin(redis, request.ip, username, password);
      if (result === 'locked') {
        return reply.code(429).send({ error: 'LOGIN_LOCKED', hint: '连续失败过多，15 分钟后自动解锁' });
      }
      if (result !== 'ok') {
        return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
      }
      const user = await prisma.adminUser.findUniqueOrThrow({ where: { username } });
      const { sessionId, data } = await createSession(redis, { id: user.id, username: user.username });
      reply.setCookie('xsq_session', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
        path: '/',
        maxAge: 8 * 60 * 60,
      });
      await prisma.auditLog.create({ data: { action: 'login', operator: username, ipAddress: request.ip } });
      return { csrfToken: data.csrfToken, mustChangePassword: user.mustChangePassword };
    },
  );

  app.post('/api/logout', { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.session) await destroySession(redis, request.session.sessionId);
    reply.clearCookie('xsq_session', { path: '/' });
    return { ok: true };
  });

  app.post('/api/change-password', { preHandler: [app.requireAuth, app.csrfGuard] }, async (request, reply) => {
    const { newPassword } = request.body as { newPassword?: string };
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: 'WEAK_PASSWORD', min: MIN_PASSWORD_LENGTH });
    }
    try {
      await changePassword(request.session!.userId, newPassword);
    } catch (error) {
      if (error instanceof WeakPasswordError) return reply.code(400).send({ error: 'WEAK_PASSWORD' });
      throw error;
    }
    return { ok: true };
  });

  registerXOAuthRoutes(app, { redis, config, encryptor });
  registerRoutes(app, { redis, config, encryptor });

  // 启动即探库（§20.1）：连不上直接退出，避免「半死」容器骗过 HEALTHCHECK
  const db = await checkDatabaseHealth();
  if (!db.ok) throw new Error('数据库连接检查失败，进程拒绝启动');

  app.addHook('onClose', async () => {
    await redis.quit();
    await disconnectPrisma();
  });

  return { app, config, bullConnection };
}

// 直接运行（Docker CMD / pnpm dev:api）时启动监听
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const { app, config } = await buildServer();
  await app.listen({ port: config.apiPort, host: '127.0.0.1' });
}
