'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type BinanceAccountView } from '@/lib/api';

/** Binance 账号页（§17.1）：密钥只显掩码，保存时只提交新值。 */
export default function BinanceAccountsPage() {
  const [accounts, setAccounts] = useState<BinanceAccountView[]>([]);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  async function reload() {
    setAccounts(await api.binanceAccounts());
  }

  useEffect(() => {
    reload().catch(() => undefined);
  }, []);

  async function save(id: string) {
    await api.saveBinanceAccount(id, { ...(name ? { name } : {}), ...(apiKey ? { apiKey } : {}) });
    setName('');
    setApiKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await reload();
  }

  return (
    <Shell>
      <h1 className="mb-6 text-xl font-semibold">Binance 账号</h1>
      <p className="mb-4 text-xs leading-5 text-slate-500">
        密钥获取：Binance Square 创作者中心 → AI Skills / API Management → 生成 Publishing API Key。
        该密钥与资产、交易接口完全隔离。出于安全考虑，页面只显示掩码，永不回显完整值。
      </p>
      {accounts.length === 0 ? (
        <p className="text-sm text-slate-500">尚未配置 Binance 账号。</p>
      ) : (
        <div className="space-y-4">
          {accounts.map((a) => (
            <div key={a.id} className="rounded border border-slate-200 bg-white p-4 text-sm">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-medium">{a.name}</span>
                <span className="font-mono text-xs text-slate-500">{a.apiKeyMasked}</span>
              </div>
              <div className="flex gap-2">
                <input className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" placeholder="新名称（可选）" value={name} onChange={(e) => setName(e.target.value)} />
                <input className="w-72 rounded border border-slate-300 px-2 py-1 text-sm" type="password" placeholder="粘贴新密钥以替换（留空不修改）" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
                <button className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-40" disabled={!name && !apiKey} onClick={() => save(a.id)}>保存</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {saved && <p className="mt-4 text-sm text-emerald-700">已保存。</p>}
    </Shell>
  );
}
