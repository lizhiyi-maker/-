import { grantQuotaAction, setUserStatusAction } from "@/app/actions/admin";
import { GrantQuotaForm } from "@/components/admin-forms";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  const users = await getServices().admin.listUsers(admin.id);
  return (
    <ul className="space-y-3" data-testid="user-list">
      {users.map((u) => (
        <li key={u.id}>
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="font-mono">{u.phoneMasked}</span>
                <Badge className="ml-2" tone={u.role === "ADMIN" ? "primary" : "muted"}>
                  {u.role === "ADMIN" ? "管理员" : "用户"}
                </Badge>
                <Badge className="ml-1" tone={u.status === "ACTIVE" ? "muted" : "warn"}>
                  {u.status === "ACTIVE" ? "正常" : u.status === "DELETING" ? "删除中" : "已停用"}
                </Badge>
                <p className="mt-1 text-xs text-muted-foreground">
                  注册 {formatDateTime(u.createdAt)} · 最近登录 {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}
                </p>
              </div>
              {u.id !== admin.id && u.status !== "DELETING" && (
                <form action={setUserStatusAction.bind(null, u.id, u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>
                  <Button type="submit" size="sm" variant="outline">
                    {u.status === "ACTIVE" ? "停用" : "恢复"}
                  </Button>
                </form>
              )}
            </div>
            <GrantQuotaForm action={grantQuotaAction.bind(null, u.id)} />
          </Card>
        </li>
      ))}
    </ul>
  );
}
