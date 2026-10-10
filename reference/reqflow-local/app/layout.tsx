import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {width:"device-width", initialScale:1, viewportFit:"cover", themeColor:"#f5f7f8"};

export const metadata: Metadata = {
  title: "ReqFlow · 需求流",
  description: "记录需求、生成 Prompt、跟踪执行与验收。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
