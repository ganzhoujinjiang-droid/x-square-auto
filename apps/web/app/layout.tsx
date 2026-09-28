import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'X → Binance Square 同步后台',
  description: '只读 X 官方 API、只写 Binance Square 的单向同步管道（V1）',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
