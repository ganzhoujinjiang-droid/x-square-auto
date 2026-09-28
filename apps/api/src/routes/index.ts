/**
 * 后台业务路由（§17）：账号、规则、记录、待确认、健康检查。
 *
 * 安全约束在每条路由上显式声明：
 *   - 全部 preHandler requireAuth；写操作再过 csrfGuard（§19.2）；
 *   - 响应永不包含完整密钥，只有掩码（§11.6 / §7.4）。
 */

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { prisma } from '@x-square/database';
import { Encryptor, hashPassword, MIN_PASSWORD_LENGTH, WeakPasswordError } from '@x-square/crypto';
import { manualTransition } from '@x-square/workers';
import { checkQuota } from '@x-square/queue';
import {
  maskSecret,
  JOB_STATUS,
  isJobStatus,
  parseJobStatus,
} from '@x-square/shared';
import {
  syncRulesSchema,
  systemSettingsSchema,
  SETTING_KEYS,
  DEFAULT_SYNC_RULES,
  DEFAULT_SYSTEM_SETTINGS,
} from '@x-square/schemas';
import type { AppConfig } from '../config.js';
import { makeRequireAuth, makeCsrfGuard } from '../auth.js';

export interface ApiDeps {
  redis: Redis;
  config: AppConfig;
  encryptor: Encryptor;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { redis, encryptor } = deps;
  const requireAuth = makeRequireAuth(redis);
  const csrfGuard = makeCsrfGuard();

  // ---- 健康检查（§20.1，无鉴权，供 Docker HEALTHCHECK 与 Caddy 探活） ----
  app.get('/health', async () => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);
    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      checks: { database: dbOk, redis: redisOk },
      timestamp: new Date().toISOString(),
    };
  });

  // ---- X 账号（§17.3） ----
  app.get('/api/x-accounts', { preHandler: [requireAuth] }, async () => {
    const accounts = await prisma.xAccount.findMany({ orderBy: { createdAt: 'desc' } });
    // Token 密文绝不出 API（§7.4）；只回非敏感状态字段
    return accounts.map((a) => ({
      id: a.id,
      xUserId: a.xUserId,
      username: a.username,
      status: a.status,
      lastTweetId: a.lastTweetId,
      baselineTweetId: a.baselineTweetId,
      lastPollAt: a.lastPollAt,
      lastPollStatus: a.lastPollStatus,
      consecutiveFailures: a.consecutiveFailures,
      pollIntervalSec: a.pollIntervalSec,
      monitoringEnabled: a.monitoringEnabled,
      tokenExpiresAt: a.tokenExpiresAt,
    }));
  });

  app.post('/api/x-accounts/:id/pause', { preHandler: [requireAuth, csrfGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    await prisma.xAccount.update({ where: { id }, data: { monitoringEnabled: false, status: 'PAUSED' } });
    return { ok: true };
  });

  app.post('/api/x-accounts/:id/resume', { preHandler: [requireAuth, csrfGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    await prisma.xAccount.update({ where: { id }, data: { monitoringEnabled: true, status: 'ACTIVE' } });
    return { ok: true };
  });

  // ---- Binance 账号（§17 页面清单） ----
  app.get('/api/binance-accounts', { preHandler: [requireAuth] }, async () => {
    const accounts = await prisma.binanceAccount.findMany();
    return accounts.map((a) => ({ id: a.id, name: a.name, apiKeyMasked: a.apiKeyMasked, status: a.status }));
  });

  app.put('/api/binance-accounts/:id', { preHandler: [requireAuth, csrfGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; apiKey?: string };
    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name;
    if (body.apiKey) {
      // 修改时只接受新值、不回显旧值（§11.6）
      data.apiKeyEncrypted = encryptor.encrypt(body.apiKey);
      data.apiKeyMasked = maskSecret(body.apiKey);
    }
    await prisma.binanceAccount.update({ where: { id }, data });
    return { ok: true };
  });

  // ---- 同步规则（§17.5） ----
  app.get('/api/settings/sync-rules', { preHandler: [requireAuth] }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.syncRules } });
    return row ? row.value : DEFAULT_SYNC_RULES;
  });

  app.put('/api/settings/sync-rules', { preHandler: [requireAuth, csrfGuard] }, async (request, reply) => {
    const parsed = syncRulesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_RULES', issues: parsed.error.issues.slice(0, 5) });
    await prisma.setting.upsert({
      where: { key: SETTING_KEYS.syncRules },
      create: { key: SETTING_KEYS.syncRules, value: parsed.data },
      update: { value: parsed.data },
    });
    return { ok: true };
  });

  app.get('/api/settings/system', { preHandler: [requireAuth] }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.system } });
    return row ? row.value : DEFAULT_SYSTEM_SETTINGS;
  });

  app.put('/api/settings/system', { preHandler: [requireAuth, csrfGuard] }, async (request, reply) => {
    const parsed = systemSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_SETTINGS' });
    await prisma.setting.upsert({
      where: { key: SETTING_KEYS.system },
      create: { key: SETTING_KEYS.system, value: parsed.data },
      update: { value: parsed.data },
    });
    return { ok: true };
  });

  // ---- 同步记录（§17.4） ----
  app.get('/api/sync-jobs', { preHandler: [requireAuth] }, async (request) => {
    const q = request.query as { status?: string; page?: string; pageSize?: string };
    const pageSize = Math.min(Number(q.pageSize ?? 50), 200);
    const page = Math.max(Number(q.page ?? 1), 1);
    const where = q.status && isJobStatus(q.status) ? { status: parseJobStatus(q.status) } : {};
    const [total, items] = await Promise.all([
      prisma.syncJob.count({ where }),
      prisma.syncJob.findMany({
        where,
        include: { xPost: { select: { xPostId: true, text: true, postType: true, tweetUrl: true, xCreatedAt: true } } },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  });

  app.get('/api/sync-jobs/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.syncJob.findUnique({
      where: { id },
      include: { history: { orderBy: { createdAt: 'asc' } }, binancePosts: true, xPost: true },
    });
    if (!job) return reply.code(404).send({ error: 'NOT_FOUND' });
    return job;
  });

  // ---- 待确认任务（§17.6 / §9.3 人工出口） ----
  app.get('/api/uncertain-jobs', { preHandler: [requireAuth] }, async () => {
    return prisma.syncJob.findMany({
      where: { status: JOB_STATUS.uncertain },
      include: { xPost: { select: { xPostId: true, text: true, tweetUrl: true } } },
      orderBy: { finishedAt: { sort: 'desc', nulls: 'last' } },
    });
  });

  /**
   * UNCERTAIN → QUEUED（「确认未发布并允许重试」）或 SUCCESS（「确认已发布」）。
   * operator 取会话用户名，进审计（§20.3）。
   */
  app.post('/api/sync-jobs/:id/resolve', { preHandler: [requireAuth, csrfGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action: 'retry' | 'confirm-published' | 'cancel'; binancePostId?: string };
    const operator = request.session?.username ?? 'unknown';

    if (body.action === 'retry') {
      await manualTransition(id, JOB_STATUS.queued, operator, { via: 'resolve-retry' });
    } else if (body.action === 'confirm-published') {
      await prisma.binancePost.updateMany({
        where: { syncJobId: id, binancePostId: null },
        data: { binancePostId: body.binancePostId ?? null, status: 'SUCCESS' },
      });
      await manualTransition(id, JOB_STATUS.success, operator, { via: 'resolve-confirm', postId: body.binancePostId });
    } else if (body.action === 'cancel') {
      await manualTransition(id, JOB_STATUS.cancelled, operator, { via: 'resolve-cancel' });
    } else {
      return reply.code(400).send({ error: 'BAD_ACTION' });
    }
    await prisma.auditLog.create({
      data: { action: `job.${body.action}`, operator, targetType: 'sync_job', targetId: id },
    });
    return { ok: true };
  });

  // ---- Dashboard（§17.2） ----
  app.get('/api/dashboard', { preHandler: [requireAuth] }, async () => {
    const since24h = new Date(Date.now() - 86_400_000);
    const [todaySuccess, todayFailed, todayUncertain, queued, accounts, usageAgg] = await Promise.all([
      prisma.syncJob.count({ where: { status: JOB_STATUS.success, finishedAt: { gte: since24h } } }),
      prisma.syncJob.count({ where: { status: JOB_STATUS.failed, finishedAt: { gte: since24h } } }),
      prisma.syncJob.count({ where: { status: JOB_STATUS.uncertain } }),
      prisma.syncJob.count({ where: { status: { in: [JOB_STATUS.discovered, JOB_STATUS.queued, JOB_STATUS.processing, JOB_STATUS.mediaProcessing, JOB_STATUS.publishing] } } }),
      prisma.xAccount.findMany({ select: { id: true, status: true, lastPollAt: true, lastPollStatus: true, consecutiveFailures: true } }),
      prisma.apiUsageLog.aggregate({ where: { createdAt: { gte: since24h } }, _sum: { totalCostUsd: true } }),
    ]);
    const account = accounts[0];
    const quota = account
      ? await checkQuota(redis, accounts[0]!.id, 'post_count')
      : null;
    return {
      jobs: { success24h: todaySuccess, failed24h: todayFailed, uncertain: todayUncertain, active: queued },
      costEstimate24hUsd: Number(usageAgg._sum.totalCostUsd ?? 0),
      accounts,
      binancePostQuota: quota,
    };
  });

  // ---- 系统日志页（§17.1）：V1 读 Pino 文件由 web 层负责，API 只提供健康摘要 ----
  app.get('/api/system/overview', { preHandler: [requireAuth] }, async () => {
    const counts = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
      SELECT status, COUNT(*)::bigint AS n FROM sync_jobs GROUP BY status
    `;
    return Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
  });
}
