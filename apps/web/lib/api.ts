/**
 * Web 后台 API 客户端（§17）。
 *
 * 浏览器只与本应用同源通信；CSRF Token 由登录响应下发后随写请求头携带。
 * 401 统一跳回登录页，避免每个页面重复处理会话过期。
 */

const BASE = '';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET' && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHENTICATED');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ csrfToken: string; mustChangePassword: boolean }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  dashboard: () => request<DashboardData>('/api/dashboard'),
  xAccounts: () => request<XAccountView[]>('/api/x-accounts'),
  pauseXAccount: (id: string) => request(`/api/x-accounts/${id}/pause`, { method: 'POST' }),
  resumeXAccount: (id: string) => request(`/api/x-accounts/${id}/resume`, { method: 'POST' }),
  binanceAccounts: () => request<BinanceAccountView[]>('/api/binance-accounts'),
  saveBinanceAccount: (id: string, data: { name?: string; apiKey?: string }) =>
    request(`/api/binance-accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  syncRules: () => request<SyncRulesView>('/api/settings/sync-rules'),
  saveSyncRules: (rules: SyncRulesView) =>
    request('/api/settings/sync-rules', { method: 'PUT', body: JSON.stringify(rules) }),
  syncJobs: (status?: string, page = 1) =>
    request<PagedJobs>(`/api/sync-jobs?page=${page}${status ? `&status=${status}` : ''}`),
  uncertainJobs: () => request<UncertainJobView[]>('/api/uncertain-jobs'),
  resolveJob: (id: string, action: 'retry' | 'confirm-published' | 'cancel', binancePostId?: string) =>
    request(`/api/sync-jobs/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, ...(binancePostId ? { binancePostId } : {}) }),
    }),
};

// ---- 视图类型（与 API 返回结构对齐的宽松子集） ----

export interface DashboardData {
  jobs: { success24h: number; failed24h: number; uncertain: number; active: number };
  costEstimate24hUsd: number;
  accounts: Array<{ id: string; status: string; lastPollAt: string | null; lastPollStatus: string | null; consecutiveFailures: number }>;
  binancePostQuota: { used: number; limit: number; warn: boolean } | null;
}

export interface XAccountView {
  id: string;
  username: string;
  status: string;
  lastTweetId: string | null;
  baselineTweetId: string | null;
  lastPollAt: string | null;
  lastPollStatus: string | null;
  consecutiveFailures: number;
  pollIntervalSec: number;
  monitoringEnabled: boolean;
  tokenExpiresAt: string;
}

export interface BinanceAccountView {
  id: string;
  name: string;
  apiKeyMasked: string;
  status: string;
}

export interface SyncRulesView {
  enabled: boolean;
  postTypes: { original: boolean; quote: boolean; reply: boolean; repost: boolean };
  keywords: { include: string[]; exclude: string[]; caseSensitive: boolean };
  textMode: 'raw' | 'template' | 'ai';
  template: string;
  keepSourceLink: boolean;
  hashtags: string;
}

export interface PagedJobs {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    status: string;
    filterReason: string | null;
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    xPost: { xPostId: string; text: string; postType: string; tweetUrl: string; xCreatedAt: string };
  }>;
}

export interface UncertainJobView {
  id: string;
  uncertainReason: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  xPost: { xPostId: string; text: string; tweetUrl: string };
}
