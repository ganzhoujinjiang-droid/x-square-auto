'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type UncertainJobView } from '@/lib/api';

/** 待确认任务页（§17.6 / §9.3）：UNCERTAIN 的人工三选一出口。 */
export default function FailedJobsPage() {
  const [jobs, setJobs] = useState<UncertainJobView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload() {
    setJobs(await api.uncertainJobs());
  }

  useEffect(() => {
    reload().catch(() => undefined);
  }, []);

  async function resolve(id: string, action: 'retry' | 'confirm-published' | 'cancel') {
    setBusy(id);
    try {
      await api.resolveJob(id, action);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell>
      <h1 className="mb-2 text-xl font-semibold">待确认任务</h1>
      <p className="mb-6 text-sm text-slate-500">
        ⚠ 这些任务的发布请求已发出但结果未知（超时 / 504 / 连接中断）。系统不会自动重发——请先打开 Binance Square 核对，再选择下方操作。
      </p>
      {jobs.length === 0 ? (
        <p className="rounded bg-emerald-50 p-4 text-sm text-emerald-700">当前没有待确认任务。</p>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <div key={job.id} className="rounded border border-amber-300 bg-white p-4 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-xs text-slate-500">{job.xPost.xPostId}</span>
                <span className="text-xs text-amber-700">{job.uncertainReason ?? 'UNKNOWN'}</span>
              </div>
              <p className="mb-1 line-clamp-3">{job.xPost.text}</p>
              <a className="mb-3 inline-block text-xs text-sky-700 underline" href={job.xPost.tweetUrl} target="_blank" rel="noreferrer">查看 X 原帖</a>
              <div className="flex gap-2">
                <button className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40" disabled={busy === job.id} onClick={() => resolve(job.id, 'retry')}>
                  确认未发布 → 允许重试
                </button>
                <button className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40" disabled={busy === job.id} onClick={() => resolve(job.id, 'confirm-published')}>
                  确认已发布 → 标记成功
                </button>
                <button className="rounded border border-red-200 px-3 py-1 text-red-600 disabled:opacity-40" disabled={busy === job.id} onClick={() => resolve(job.id, 'cancel')}>
                  放弃该帖
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
