import Link from 'next/link';

/** 后台左侧导航（§17.1 页面清单）。 */
export function Nav() {
  const items = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/x-accounts', label: 'X 账号' },
    { href: '/binance-accounts', label: 'Binance 账号' },
    { href: '/rules', label: '同步规则' },
    { href: '/sync-logs', label: '同步记录' },
    { href: '/failed-jobs', label: '待确认 / 失败' },
    { href: '/settings', label: '设置' },
  ];
  return (
    <aside className="w-56 shrink-0 border-r border-slate-200 bg-white p-4">
      <div className="mb-6 text-sm font-semibold text-slate-500">X → Square 同步</div>
      <nav className="space-y-1">
        {items.map((item) => (
          <Link key={item.href} href={item.href} className="block rounded px-3 py-2 text-sm hover:bg-slate-100">
            {item.label}
          </Link>
        ))}
      </nav>
      <p className="mt-8 text-xs leading-5 text-slate-400">
        编辑/删除已发布帖子平台不支持；结果未知时系统只会停下等你确认。
      </p>
    </aside>
  );
}
