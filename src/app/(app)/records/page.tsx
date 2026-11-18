import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/card";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

/** 记录入口：选择一个对象，进入它的线下事件、好感变化与分析快照时间线。 */
export default async function Page() {
  const user = await requireUser();
  const people = await getServices().people.list(user.id, "ALL");
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">记录</h1>
      <p className="text-sm text-muted-foreground">补充线下事件，并在时间线上复盘好感变化与每次分析的结论。选择一个对象：</p>
      {people.length === 0 ? (
        <EmptyState title="还没有对象">先创建一个对象，再来记录。</EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="records-people">
          {people.map((p) => (
            <li key={p.id}>
              <Card className="flex items-center justify-between">
                <span className="font-medium">{p.nickname}</span>
                <Link href={`/people/${p.id}?tab=records`} className="text-sm text-primary">
                  查看时间线
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
