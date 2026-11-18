import Link from "next/link";
import { FeedbackForm } from "@/components/feedback-form";
import { Badge, Card, CardTitle } from "@/components/ui/card";
import { FEEDBACK_CATEGORY_LABEL } from "@/domain/feedback";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

export default async function FeedbackPage() {
  const user = await requireUser();
  const mine = await getServices().feedback.mine(user.id);
  return (
    <section className="mx-auto max-w-xl space-y-4">
      <Link href="/me" className="text-sm text-muted-foreground">
        ← 返回
      </Link>
      <h1 className="text-xl font-semibold">意见反馈</h1>
      <Card>
        <FeedbackForm />
      </Card>
      {mine.length > 0 && (
        <Card data-testid="my-feedback">
          <CardTitle>我提交过的反馈</CardTitle>
          <ul className="divide-y text-sm">
            {mine.map((f) => (
              <li key={f.id} className="py-2">
                <div className="flex items-center gap-2">
                  <Badge>{FEEDBACK_CATEGORY_LABEL[f.category]}</Badge>
                  <Badge tone={f.status === "HANDLED" ? "primary" : "muted"}>{f.status === "HANDLED" ? "已处理" : "待处理"}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(f.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words">{f.message}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
