'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type PagedJobs } from '@/lib/api';

const STATUS_FILTERS = ['', 'DISCOVERED', 'FILTERED', 'QUEUED', 'SUCCESS', 'FAILED', 'UNCERTAIN'] as const;

/** 同步记录页（§17.4）：状态筛选、分页、每行可查类型与原因。 */
export default function SyncLogsPage() {
  const [data, setData] = useState<PagedJobs | null>(null);
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.syncJobs(status || undefined, page).then(setData).catch(() => undefined);
  }, [status, page]);

  const totalPages = data ? Math.max(Math.ceil(data.total / data.pageSize), 1) : 1;

  return (
    <Shell>
      <h1 className="mb-6 text-xl font-semibold">同步记录</h1>
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-slate-500">状态：</span>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s || 'all'}
            className={`rounded px-2 py-1 ${status === s ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'}`}
            onClick={() => { setStatus(s); setPage(1); }}
          >
            {s || '全部'}
          </button>
        ))}
      </div>
      {!data ? (
        <p className="text-sm text-slate-500">加载中…</p>
      ) : (
        <>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 pr-3">X ID</th>
                <th className="py-2 pr-3">类型</th>
                <th className="py-2 pr-3">正文</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">原因 / 错误</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((job) => (
                <tr key={job.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-mono text-xs">{job.xPost.xPostId}</td>
                  <td className="py-2 pr-3">{job.xPost.postType}</td>
                  <td className="max-w-md truncate py-2 pr-3" title={job.xPost.text}>{job.xPost.text}</td>
                  <td className="py-2 pr-3">{job.status}</td>
                  <td className="max-w-xs py-2 text-xs text-slate-500">{job.filterReason ?? job.errorMessage ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <button className="rounded border border-slate-200 bg-white px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="text-slate-500">{page} / {totalPages}（共 {data.total} 条）</span>
            <button className="rounded border border-slate-200 bg-white px-3 py-1 disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </>
      )}
    </Shell>
  );
}
