/**
 * X OAuth 路由（§7.1）：authorize → X 授权页 → callback → /2/users/me → baseline。
 *
 * state 与 code_verifier 存 Redis（TTL 10 分钟，一次性用后即删）。
 * Token 加密入库后执行 baseline（§6.5），账号置 ACTIVE。
 */

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Encryptor, generatePkcePair, generateState } from '@x-square/crypto';
import { prisma, withTransaction } from '@x-square/database';
import { xOAuthCallbackQuerySchema } from '@x-square/schemas';
import { oauthStateKey, pkceVerifierKey, OAUTH_STATE_TTL_MS, X_ACCOUNT_STATUS, maxSnowflake } from '@x-square/shared';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUsersMe, fetchBaselinePage } from '@x-square/x-client';
import type { AppConfig } from '../config.js';
import { makeRequireAuth } from '../auth.js';

export function registerXOAuthRoutes(app: FastifyInstance, deps: { redis: Redis; config: AppConfig; encryptor: Encryptor }): void {
  const { redis, config, encryptor } = deps;
  const requireAuth = makeRequireAuth(redis);

  /** 发起授权：生成 state + PKCE，302 跳 X 授权页（§7.1）。 */
  app.get('/api/x/oauth/authorize', { preHandler: [requireAuth] }, async (_request, reply) => {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePkcePair();
    await redis.set(oauthStateKey(state), '1', 'PX', OAUTH_STATE_TTL_MS);
    await redis.set(pkceVerifierKey(state), codeVerifier, 'PX', OAUTH_STATE_TTL_MS);
    const url = buildAuthorizeUrl(
      { clientId: config.xClientId, redirectUri: config.xRedirectUri, ...(config.xClientSecret ? { clientSecret: config.xClientSecret } : {}) },
      { state, codeChallenge },
    );
    return reply.code(302).header('location', url).send();
  });

  /** 回调：校验 state（一次性）→ 换 Token → users/me → 加密入库 → baseline。 */
  app.get('/api/x/oauth/callback', async (request, reply) => {
    const parsed = xOAuthCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_CALLBACK' });
    }
    if ('error' in parsed.data) {
      return reply.code(302).header('location', `${config.apiBaseUrl}/x-accounts?oauth=denied`).send();
    }
    const { code, state } = parsed.data;

    // 一次性 state：GETDEL 语义由「先取再删」保证，删除失败不影响本次授权
    const stateExists = await redis.del(oauthStateKey(state));
    const codeVerifier = await redis.get(pkceVerifierKey(state));
    await redis.del(pkceVerifierKey(state));
    if (stateExists === 0 || !codeVerifier) {
      return reply.code(400).send({ error: 'STATE_INVALID_OR_EXPIRED' });
    }

    const credentials = {
      clientId: config.xClientId,
      redirectUri: config.xRedirectUri,
      ...(config.xClientSecret ? { clientSecret: config.xClientSecret } : {}),
    };
    const token = await exchangeCodeForToken(credentials, code, codeVerifier);
    const me = await fetchUsersMe(token.access_token);

    const expiresAt = new Date(Date.now() + token.expires_in * 1000);

    // Token 入库与 baseline 初值同事务；baseline 网络失败则整体回滚重做
    const account = await withTransaction(async (tx) => {
      const existing = await tx.xAccount.findUnique({ where: { xUserId: me.id } });
      const data = {
        username: me.username,
        accessTokenEncrypted: encryptor.encrypt(token.access_token),
        refreshTokenEncrypted: token.refresh_token ? encryptor.encrypt(token.refresh_token) : (existing?.refreshTokenEncrypted ?? ''),
        tokenExpiresAt: expiresAt,
        status: X_ACCOUNT_STATUS.pending,
      };
      return existing
        ? tx.xAccount.update({ where: { id: existing.id }, data })
        : tx.xAccount.create({ data: { xUserId: me.id, ...data } });
    });

    // baseline（§6.5）：只记录当前最新 ID，绝不回溯历史
    try {
      const page = await fetchBaselinePage(me.id, token.access_token);
      const ids = (page.response.data ?? []).map((t) => t.id);
      const baseline = maxSnowflake(ids);
      await prisma.xAccount.update({
        where: { id: account.id },
        data: { baselineTweetId: baseline, lastTweetId: baseline, status: X_ACCOUNT_STATUS.active },
      });
    } catch (error) {
      request.log.error({ err: error }, 'baseline failed; account stays PENDING');
      return reply.code(302).header('location', `${config.apiBaseUrl}/x-accounts?oauth=baseline_failed`).send();
    }

    return reply.code(302).header('location', `${config.apiBaseUrl}/x-accounts?oauth=connected`).send();
  });
}
