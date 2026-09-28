'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setCsrfToken } from '@/lib/api';

/** 登录页（§19.1）。失败锁定与限流提示由 API 错误码驱动。 */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      setCsrfToken(result.csrfToken);
      router.push(result.mustChangePassword ? '/settings' : '/dashboard');
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'LOGIN_LOCKED'
          ? '连续失败次数过多，账号已临时锁定，请稍后再试'
          : '用户名或密码错误',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">登录后台</h1>
        <input
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          className="w-full rounded bg-slate-900 py-2 text-sm text-white disabled:opacity-50"
          disabled={busy || !username || !password}
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
