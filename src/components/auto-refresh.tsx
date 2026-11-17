"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 识别进行中时定期重新读取服务端进度；离开页面不影响后台任务，回来或刷新后进度从服务端恢复。 */
export function AutoRefresh({ active, intervalMs = 2000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
