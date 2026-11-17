import { createInviteAction, revokeInviteAction } from "@/app/actions/admin";
import { CreateInviteForm } from "@/components/admin-forms";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

const STATUS_LABEL = { ACTIVE: "可用", REVOKED: "已撤销", EXPIRED: "已过期", EXHAUSTED: "已用完" } as const;

export default async function AdminInvitesPage() {
  const admin = await requireAdmin();
  const invites = await getServices().admin.listInvites(admin.id);
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>生成邀请码</CardTitle>
        <p className="mb-2 text-xs text-muted-foreground">依次为：可使用次数、有效天数、备注。</p>
        <CreateInviteForm action={createInviteAction} />
      </Card>
      <Card className="overflow-x-auto">
        <CardTitle>邀请码列表</CardTitle>
        <table className="w-full text-left text-sm" data-testid="invite-table">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">邀请码</th>
              <th className="pr-3">已用/上限</th>
              <th className="pr-3">到期</th>
              <th className="pr-3">状态</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {invites.map((i) => {
              const status = STATUS_LABEL[i.status];
              return (
                <tr key={i.id}>
                  <td className="py-2 pr-3 font-mono">{i.code}</td>
                  <td className="pr-3">
                    {i.usedCount}/{i.maxUses}
                  </td>
                  <td className="pr-3">{formatDate(i.expiresAt)}</td>
                  <td className="pr-3">
                    <Badge tone={i.status === "ACTIVE" ? "primary" : "muted"}>{status}</Badge>
                  </td>
                  <td>
                    {i.status === "ACTIVE" && (
                      <form action={revokeInviteAction.bind(null, i.id)}>
                        <Button type="submit" size="sm" variant="ghost">
                          撤销
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {invites.length === 0 && <p className="py-3 text-sm text-muted-foreground">还没有邀请码。</p>}
      </Card>
    </div>
  );
}
