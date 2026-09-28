'use client';

import { useState } from 'react';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';

/** 设置页（§17.1）：修改密码 + 退出登录。 */
export default function SettingsPage() {
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function change() {
    setMessage(null);
    try {
      await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ newPassword }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(String((await r.json()).error ?? r.status));
        setMessage('密码已更新，请牢记。');
        setNewPassword('');
      });
    } catch (err) {
      setMessage(err instanceof Error && err.message === 'WEAK_PASSWORD' ? '密码强度不足（至少 12 字符）' : '更新失败');
    }
  }

  return (
    <Shell>
      <h1 className="mb-6 text-xl font-semibold">设置</h1>
      <section className="mb-6 max-w-md rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-3 font-medium">修改管理员密码</h2>
        <input
          type="password"
          className="mb-2 w-full rounded border border-slate-300 px-2 py-1"
          placeholder="新密码（≥12 字符）"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
        <button className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-40" disabled={newPassword.length < 12} onClick={change}>
          更新密码
        </button>
        {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}
      </section>
      <button
        className="rounded border border-red-200 px-4 py-2 text-sm text-red-600"
        onClick={async () => {
          await api.logout();
          window.location.href = '/login';
        }}
      >
        退出登录
      </button>
    </Shell>
  );
}
