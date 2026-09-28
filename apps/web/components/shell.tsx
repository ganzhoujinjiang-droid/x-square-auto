import { Nav } from '@/components/nav';

/** 受保护页面的统一外壳：左侧导航 + 内容区。 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
