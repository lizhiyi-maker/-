import Link from "next/link";
import { requireAdmin } from "@/server/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">管理后台</h1>
        <nav aria-label="后台导航" className="flex gap-3 text-sm">
          <Link href="/admin">邀请码</Link>
          <Link href="/admin/users">用户与额度</Link>
          <Link href="/admin/audit">审计记录</Link>
        </nav>
      </div>
      <p className="text-xs text-muted-foreground">管理员默认不能浏览用户的完整聊天内容；所有管理操作都会写入审计记录。</p>
      {children}
    </div>
  );
}
