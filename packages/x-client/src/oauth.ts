/**
 * X OAuth 2.0 Authorization Code + PKCE（§7.1、§7.2）。
 *
 * 本模块只负责「换 Token」这一步的 HTTP 调用；state / code_verifier 的
 * 生成与暂存（Redis, TTL 10 分钟）由 API 层完成（§7.1），
 * 加密入库与 baseline 执行由上层服务完成（§7.4、§6.5）。
 *
 * scope 白名单由 schemas/x-api.ts 的 assertXScopes 强制（§7.2）：
 * 缺必需项或出现任何写入 scope 都会抛错——这是「只读 X」边界的代码化。
 */

import {
  assertXScopes,
  xTokenRefreshResponseSchema,
  xTokenResponseSchema,
  xUserMeResponseSchema,
  type XTokenRefreshResponse,
  type XTokenResponse,
} from '@x-square/schemas';
import { X_OAUTH_AUTHORIZE_URL, X_OAUTH_TOKEN_URL, X_API_BASE_URL } from '@x-square/shared';

import { XSchemaValidationError } from './errors.js';
import { requestJson, type TransportOptions } from './http.js';

/** OAuth 客户端凭据。clientSecret 在内存中流转，绝不写日志（§7.6）。 */
export interface XOauthCredentials {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** 构建授权跳转 URL（§7.1：302 跳转 X 授权页）。 */
export function buildAuthorizeUrl(
  credentials: XOauthCredentials,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(X_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', credentials.redirectUri);
  url.searchParams.set('scope', 'tweet.read users.read offline.access');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Token 端点使用 form-urlencoded（OAuth 规范，非 JSON）。 */
function formBody(fields: Record<string, string>): string {
  const body = new URLSearchParams(fields);
  return body.toString();
}

async function postToken(
  form: string,
  basicAuth: string | undefined,
  options: TransportOptions,
): Promise<unknown> {
  const { json } = await requestJson(
    X_OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(basicAuth ? { Authorization: `Basic ${basicAuth}` } : {}),
      },
      body: form,
    },
    options,
  );
  return json;
}

function basic(clientId: string, clientSecret?: string): string | undefined {
  if (!clientSecret) return undefined;
  // 机密客户端用 Basic 认证；公开客户端（无 secret）走 PKCE-only
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** 授权码换 Token（§7.1）。校验 scope 白名单后返回（§7.2）。 */
export async function exchangeCodeForToken(
  credentials: XOauthCredentials,
  code: string,
  codeVerifier: string,
  options: TransportOptions = {},
): Promise<XTokenResponse> {
  const json = await postToken(
    formBody({
      grant_type: 'authorization_code',
      code,
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      code_verifier: codeVerifier,
    }),
    basic(credentials.clientId, credentials.clientSecret),
    options,
  );

  const parsed = xTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new XSchemaValidationError(
      'POST /2/oauth2/token',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  // scope 校验放在返回前：必需项缺失或含写入 scope 都立即失败（§7.2）
  assertXScopes(parsed.data.scope);
  return parsed.data;
}

/** 刷新 Token（§7.5）。返回结果必须整组覆盖旧值——refresh_token 一次性（§7.5）。 */
export async function refreshAccessToken(
  credentials: XOauthCredentials,
  refreshToken: string,
  options: TransportOptions = {},
): Promise<XTokenRefreshResponse> {
  const json = await postToken(
    formBody({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: credentials.clientId,
    }),
    basic(credentials.clientId, credentials.clientSecret),
    options,
  );

  const parsed = xTokenRefreshResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new XSchemaValidationError(
      'POST /2/oauth2/token (refresh)',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** GET /2/users/me（§7.1：授权后记录 x_user_id / username）。 */
export async function fetchUsersMe(
  accessToken: string,
  options: TransportOptions = {},
): Promise<{ id: string; username: string; name?: string }> {
  const { json } = await requestJson(
    `${X_API_BASE_URL}/2/users/me`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    options,
  );
  const parsed = xUserMeResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new XSchemaValidationError('/2/users/me', parsed.error.issues[0]?.message ?? 'unknown');
  }
  return parsed.data.data;
}
