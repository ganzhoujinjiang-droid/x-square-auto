'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type DashboardData } from '@/lib/api';

/** Dashboard（§17.2）：近 24h 成功/失败、待确认数、成本估算、轮询健康。 */
export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboard().then(setData).catch((e) => setError(String(e)));
    const timer = setInterval(() => api.dashboard().then(setData).catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <Shell><p className="text-sm text-red-600">加载失败：{error}</p></Shell>;
  if (!data) return <Shell><p className="text-sm text-slate-500">加载中…</p></Shell>;

  const account = data.accounts[0];
  return (
    <Shell>
      <h1 className="mb-6 text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="24h 发布成功" value={data.jobs.success24h} tone="ok" />
        <Stat label="24h 失败" value={data.jobs.failed24h} tone={data.jobs.failed24h > 0 ? 'bad' : 'ok'} />
        <Stat label="待人工确认" value={data.jobs.uncertain} tone={data.jobs.uncertain > 0 ? 'warn' : 'ok'} />
        <Stat label="处理中任务" value={data.jobs.active} tone="neutral" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded border border-slate-200 bg-white p-4 text-sm">
          <div className="mb-1 font-medium">X API 成本估算（24h）</div>
          <div>${data.costEstimate24hUsd.toFixed(4)}</div>
          <p className="mt-2 text-xs text-slate-500">按资源数 × Owned Reads $0.001 估算，以 Developer Console 账单为准。</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 text-sm">
          <div className="mb-1 font-medium">Binance 今日发帖配额</div>
          {data.binancePostQuota ? (
            <>
              <div>{data.binancePostQuota.used} / {data.binancePostQuota.limit}</div>
              {data.binancePostQuota.warn && (
                <p className="mt-2 text-xs text-amber-600">已接近 100 帖/日上限，请控制发帖节奏。</p>
              )}
            </>
          ) : (
            <span className="text-slate-500">未配置账号</span>
          )}
        </div>
      </div>
      {account && (
        <div className="mt-6 rounded border border-slate-200 bg-white p-4 text-sm">
          <div className="font-medium">监控状态</div>
          <ul className="mt-2 space-y-1 text-slate-600">
            <li>上次轮询：{account.lastPollAt ?? '从未'}</li>
            <li>轮询状态：{account.lastPollStatus ?? '-'}（连续失败 {account.consecutiveFailures} 次）</li>
            {account.consecutiveFailures >= 3 && (
              <li className="text-red-600">连续失败较多，请关注 Token 是否过期或网络异常。</li>
            )}
          </ul>
        </div>
      )}
    </Shell>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  const color = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-900';
  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
