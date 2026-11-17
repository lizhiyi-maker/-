import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { FRESHNESS_LABEL } from "@/domain/analysis/freshness";
import { BATCH_STATUS_LABEL } from "@/domain/imports";
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
  const { people: peopleService, imports, analysis } = getServices();
  const [people, pending, analysisTodo] = await Promise.all([peopleService.list(user.id, filter), imports.listPending(user.id), analysis.listTodo(user.id)]);

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
        {pending.length === 0 && analysisTodo.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="todo-empty">
            暂无待确认或待分析事项。导入聊天资料后，待确认的内容和有新资料待分析的对象会显示在这里。
          </p>
        ) : (
          <ul className="divide-y text-sm" data-testid="todo-pending">
            {analysisTodo.map((t) => (
              <li key={`a-${t.personId}`} className="flex items-center justify-between gap-2 py-2" data-testid="todo-analysis">
                <span>
                  <span className="font-medium">{t.nickname}</span>
                  <span className="ml-2 text-muted-foreground">{t.reason === "NEVER" ? "有资料待分析" : FRESHNESS_LABEL[t.reason].label}</span>
                </span>
                <Link href={`/people/${t.personId}?tab=analysis`} className="shrink-0 text-primary">
                  去分析
                </Link>
              </li>
            ))}
            {pending.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{b.nickname}</span>
                  <span className="ml-2 text-muted-foreground">
                    {BATCH_STATUS_LABEL[b.status]} · {b.messageCount} 条
                  </span>
                </span>
                <Link href={`/people/${b.personId}/import/${b.id}`} className="shrink-0 text-primary">
                  去确认
                </Link>
              </li>
            ))}
          </ul>
        )}
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
