import type { Metadata, Viewport } from "next";
import { DemoBanner } from "@/components/demo-banner";
import { isDemoMode } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "关系工作台",
  description: "整理互动资料，分析关系，比较发展适配程度",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

// 演示标识依据运行时环境，不能在构建期固化。
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {isDemoMode() && <DemoBanner />}
        {children}
      </body>
    </html>
  );
}
