'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { api, type SyncRulesView } from '@/lib/api';

const DEFAULT_RULES: SyncRulesView = {
  enabled: true,
  postTypes: { original: true, quote: false, reply: false, repost: false },
  keywords: { include: [], exclude: [], caseSensitive: false },
  textMode: 'template',
  template: '{text}\n\n—\n来源：@{username}\n{url}',
  keepSourceLink: true,
  hashtags: '',
};

/** 同步规则页（§17.5）：类型开关、关键词、文本模式、发布时机。 */
export default function RulesPage() {
  const [rules, setRules] = useState<SyncRulesView>(DEFAULT_RULES);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.syncRules().then((r) => {
      setRules(r);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const patch = (partial: Partial<SyncRulesView>) => setRules((prev) => ({ ...prev, ...partial }));

  async function save() {
    await api.saveSyncRules(rules);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!loaded) return <Shell><p className="text-sm text-slate-500">加载中…</p></Shell>;

  return (
    <Shell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">同步规则</h1>
        <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white" onClick={save}>保存</button>
      </div>
      {saved && <p className="mb-4 rounded bg-emerald-50 p-2 text-sm text-emerald-700">已保存。</p>}

      <section className="mb-6 rounded border border-slate-200 bg-white p-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rules.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          自动同步总开关（关闭时新帖仍入库，但一律标记为不同步）
        </label>
      </section>

      <section className="mb-6 rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-3 font-medium">帖子类型</h2>
        <div className="space-y-2">
          {(
            [
              ['original', '原创'],
              ['quote', '引用（Quote）'],
              ['reply', '回复（Reply）——脱离上下文语义不完整，不建议开启'],
              ['repost', '转推（Repost）——他人内容存在版权问题，不建议开启'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rules.postTypes[key]}
                onChange={(e) => patch({ postTypes: { ...rules.postTypes, [key]: e.target.checked } })}
              />
              {label}
            </label>
          ))}
          <p className="text-xs text-slate-500">含视频 / GIF 的帖子 V1 一律不同步。</p>
        </div>
      </section>

      <section className="mb-6 rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-3 font-medium">关键词过滤</h2>
        <label className="mb-1 block text-xs text-slate-500">包含（任一命中才同步，留空不过滤；逗号分隔）</label>
        <input
          className="mb-3 w-full rounded border border-slate-300 px-2 py-1"
          value={rules.keywords.include.join(', ')}
          onChange={(e) => patch({ keywords: { ...rules.keywords, include: splitList(e.target.value) } })}
        />
        <label className="mb-1 block text-xs text-slate-500">排除（任一命中即拦截，优先级高于包含）</label>
        <input
          className="mb-3 w-full rounded border border-slate-300 px-2 py-1"
          value={rules.keywords.exclude.join(', ')}
          onChange={(e) => patch({ keywords: { ...rules.keywords, exclude: splitList(e.target.value) } })}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={rules.keywords.caseSensitive}
            onChange={(e) => patch({ keywords: { ...rules.keywords, caseSensitive: e.target.checked } })}
          />
          区分大小写
        </label>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-3 font-medium">文本处理</h2>
        <div className="mb-3 space-x-4">
          {(['raw', 'template'] as const).map((mode) => (
            <label key={mode} className="inline-flex items-center gap-1">
              <input type="radio" name="textMode" checked={rules.textMode === mode} onChange={() => patch({ textMode: mode })} />
              {mode === 'raw' ? '原样' : '模板化'}
            </label>
          ))}
          <span className="text-xs text-slate-400">AI 改写 V1 默认关闭</span>
        </div>
        {rules.textMode === 'template' && (
          <>
            <textarea
              className="mb-2 h-28 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
              value={rules.template}
              onChange={(e) => patch({ template: e.target.value })}
            />
            <p className="text-xs text-slate-500">支持变量：{'{text} {url} {username} {date} {hashtags}'}；正文超 280 字符将黄字预警。</p>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={rules.keepSourceLink} onChange={(e) => patch({ keepSourceLink: e.target.checked })} />
              保留 X 原帖链接
            </label>
            <label className="mt-2 block">
              <span className="text-xs text-slate-500">固定标签串（{`{hashtags}`}）</span>
              <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={rules.hashtags} onChange={(e) => patch({ hashtags: e.target.value })} />
            </label>
          </>
        )}
      </section>
    </Shell>
  );
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}
