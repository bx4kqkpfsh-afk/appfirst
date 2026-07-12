import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "文图重构工作台 · DocVision Studio",
  description: "将图片中的文字、公式与系统框图提取为可编辑 Word、PPT 和 Visio 文件。",
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
      <body>{children}</body>
    </html>
  );
}
