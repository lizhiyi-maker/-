import { handleFeedbackAction } from "@/app/actions/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { FEEDBACK_CATEGORY_LABEL } from "@/domain/feedback";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

export default async function AdminFeedbackPage() {
  const admin = await requireAdmin();
  const list = await getServices().admin.listFeedback(admin.id);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">只显示用户自己写下的文字和主动附上的片段；手机号已脱敏。这里看不到用户的聊天、对象和报告。</p>
      {list.length === 0 && <EmptyState title="还没有反馈" />}
      <ul className="space-y-3" data-testid="feedback-list">
        {list.map((f) => (
          <li key={f.id}>
            <Card data-testid="feedback-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge>{FEEDBACK_CATEGORY_LABEL[f.category]}</Badge>
                  <Badge tone={f.status === "NEW" ? "warn" : "primary"}>{f.status === "NEW" ? "待处理" : "已处理"}</Badge>
                  <span className="font-mono text-xs">{f.userPhoneMasked}</span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(f.createdAt)}</span>
                </div>
                {f.status === "NEW" && (
                  <form action={handleFeedbackAction.bind(null, f.id)}>
                    <Button type="submit" size="sm" variant="outline">
                      标记已处理
                    </Button>
                  </form>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{f.message}</p>
              {f.snippet && (
                <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">用户主动附上的片段</p>
                  <p className="whitespace-pre-wrap break-words">{f.snippet}</p>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
