'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type XAccountView } from '@/lib/api';

/** X 账号页（§17.3）：连接入口、baseline 审计字段、暂停/恢复监控。 */
export default function XAccountsPage() {
  const [accounts, setAccounts] = useState<XAccountView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload() {
    setAccounts(await api.xAccounts());
  }

  useEffect(() => {
    reload().catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (oauth === 'connected') setNotice('X 账号已连接，baseline 已设置，仅同步此后发布的新帖。');
    if (oauth === 'denied') setNotice('授权被取消，未做任何变更。');
    if (oauth === 'baseline_failed') setNotice('授权成功但 baseline 读取失败，请重新连接或稍后重试。');
  }, []);

  return (
    <Shell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">X 账号</h1>
        <a
          href="/api/x/oauth/authorize"
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700"
        >
          连接 X 账号
        </a>
      </div>
      {notice && <p className="mb-4 rounded bg-sky-50 p-3 text-sm text-sky-800">{notice}</p>}
      <p className="mb-4 text-xs text-slate-500">
        V1 仅支持单账号；App Owner 必须与被监控账号一致，否则按标准价 $0.005/资源计费（5 倍）。
      </p>
      {accounts.length === 0 ? (
        <p className="text-sm text-slate-500">尚未连接任何 X 账号。</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 pr-4">用户名</th>
              <th className="py-2 pr-4">状态</th>
              <th className="py-2 pr-4">baseline</th>
              <th className="py-2 pr-4">last_tweet_id</th>
              <th className="py-2 pr-4">轮询间隔</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b border-slate-100">
                <td className="py-2 pr-4">@{a.username}</td>
                <td className="py-2 pr-4">
                  <span className={a.status === 'ACTIVE' ? 'text-emerald-700' : a.status === 'TOKEN_EXPIRED' ? 'text-red-600' : 'text-slate-600'}>
                    {a.status}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{a.baselineTweetId ?? '-'}</td>
                <td className="py-2 pr-4 font-mono text-xs">{a.lastTweetId ?? '-'}</td>
                <td className="py-2 pr-4">{a.pollIntervalSec}s</td>
                <td className="py-2 space-x-2">
                  {a.monitoringEnabled ? (
                    <button className="text-slate-600 underline" onClick={() => api.pauseXAccount(a.id).then(reload)}>暂停</button>
                  ) : (
                    <button className="text-slate-600 underline" onClick={() => api.resumeXAccount(a.id).then(reload)}>恢复</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {accounts.some((a) => a.status === 'TOKEN_EXPIRED') && (
        <p className="mt-4 text-sm text-red-600">Token 已过期：点击「连接 X 账号」重新授权。</p>
      )}
    </Shell>
  );
}
