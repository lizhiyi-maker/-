import { Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

export default async function AdminAuditPage() {
  const admin = await requireAdmin();
  const entries = await getServices().admin.listAudit(admin.id);
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="audit-table">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">时间</th>
            <th className="pr-3">操作</th>
            <th className="pr-3">对象</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap py-2 pr-3">{formatDateTime(e.createdAt)}</td>
              <td className="pr-3 font-mono">{e.action}</td>
              <td className="pr-3">{e.targetType}</td>
              <td className="font-mono text-xs">{e.meta ? JSON.stringify(e.meta) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && <p className="py-3 text-sm text-muted-foreground">暂无记录。</p>}
    </Card>
  );
}
