import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { FEELING_LABEL, STAGE_LABEL, type GenderFilter } from "@/domain/people";
import { cn } from "@/lib/utils";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

const FILTERS: { value: GenderFilter; label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "MALE", label: "男" },
  { value: "FEMALE", label: "女" },
];

export default async function HomePage({ searchParams }: { searchParams: Promise<{ gender?: string }> }) {
  const user = await requireUser();
  const { gender } = await searchParams;
  const filter: GenderFilter = gender === "MALE" || gender === "FEMALE" ? gender : "ALL";
  const people = await getServices().people.list(user.id, filter);

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">对象</h1>
        <Link
          href="/people/new"
          className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          <Plus className="size-4" aria-hidden />
          新建对象
        </Link>
      </div>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">待办</h2>
        <p className="text-sm text-muted-foreground" data-testid="todo-empty">
          暂无待确认或待分析事项。导入聊天资料后，待确认的识别结果和有新资料待分析的对象会显示在这里。
        </p>
      </Card>

      <nav aria-label="性别筛选" className="flex gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "ALL" ? "/" : `/?gender=${f.value}`}
            aria-current={filter === f.value ? "true" : undefined}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm",
              filter === f.value ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground",
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {people.length === 0 ? (
        <EmptyState title={filter === "ALL" ? "还没有对象" : "该分类下没有对象"}>
          {filter === "ALL" ? "点击“新建对象”，只需要一个昵称或代号。" : "未填写性别的对象只会出现在“全部”里。"}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="people-list">
          {people.map((p) => (
            <li key={p.id}>
              <Link href={`/people/${p.id}`} className="block rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-base font-medium">{p.nickname}</span>
                  <Badge tone={p.stage ? "primary" : "muted"}>{p.stage ? STAGE_LABEL[p.stage] : "阶段未设置"}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  我的好感：{p.feeling ? FEELING_LABEL[p.feeling] : "未填写"}
                </p>
                {(p.stage === "IN_RELATIONSHIP" || p.stage === "ENDED") && (
                  <p className="mt-1 text-xs text-muted-foreground">该阶段不参与发展推荐排名，仍可查看记录</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
