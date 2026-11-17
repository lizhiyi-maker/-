import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addAccountAction,
  deletePersonAction,
  removeAccountAction,
  setFeelingAction,
} from "@/app/actions/people";
import { AddAccountForm } from "@/components/account-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui/card";
import { FEELING_LABEL, GENDER_LABEL, PLATFORM_LABEL, STAGE_LABEL } from "@/domain/people";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getServices } from "@/server/container";
import { NotFoundError } from "@/server/people/service";
import { requireUser } from "@/server/session";

const TABS = [
  { key: "overview", label: "概览" },
  { key: "chats", label: "聊天资料" },
  { key: "analysis", label: "分析与建议" },
  { key: "records", label: "关系记录" },
] as const;

const triText = (v: boolean | null, yes: string, no: string) => (v === true ? yes : v === false ? no : "未填写");

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = TABS.find((t) => t.key === rawTab)?.key ?? "overview";
  const user = await requireUser();
  const person = await getServices()
    .people.get(user.id, id)
    .catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!person) notFound();

  return (
    <section className="space-y-4">
      <Link href="/" className="text-sm text-muted-foreground">
        ← 返回对象列表
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{person.nickname}</h1>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={person.stage ? "primary" : "muted"}>{person.stage ? STAGE_LABEL[person.stage] : "阶段未设置"}</Badge>
            {person.gender && <Badge>{GENDER_LABEL[person.gender]}</Badge>}
          </div>
        </div>
        <Link href={`/people/${id}/edit`} className="rounded-md border bg-card px-3 py-1.5 text-sm">
          编辑
        </Link>
      </div>

      <nav aria-label="对象详情" className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/people/${id}?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm",
              tab === t.key ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardTitle>基本信息</CardTitle>
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">认识渠道</dt>
              <dd>{person.channel ?? "未填写"}</dd>
              <dt className="text-muted-foreground">大概认识时间</dt>
              <dd>{person.metAtApprox ?? "未填写"}</dd>
              <dt className="text-muted-foreground">见面经历</dt>
              <dd>{triText(person.hasMet, "见过面", "没见过面")}</dd>
              <dt className="text-muted-foreground">是否暧昧</dt>
              <dd>{triText(person.seesAsAmbiguous, "我认为是", "我认为不是")}</dd>
              <dt className="text-muted-foreground">个人感受</dt>
              <dd className="whitespace-pre-wrap">{person.feelingsNote ?? "未填写"}</dd>
              <dt className="text-muted-foreground">我的期待</dt>
              <dd className="whitespace-pre-wrap">{person.expectationsNote ?? "未填写"}</dd>
            </dl>
          </Card>

          <Card>
            <CardTitle>我的好感</CardTitle>
            <p className="mb-3 text-xs text-muted-foreground">只由你填写，不参与系统评分。</p>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="我的好感">
              {Object.entries(FEELING_LABEL).map(([value, label]) => (
                <form key={value} action={setFeelingAction.bind(null, id, value)}>
                  <Button
                    type="submit"
                    variant={person.feeling?.value === value ? "default" : "outline"}
                    className="w-full"
                    aria-pressed={person.feeling?.value === value}
                  >
                    {label}
                  </Button>
                </form>
              ))}
            </div>
            {person.feelingHistory.length > 0 && (
              <ul className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground" aria-label="好感变化记录">
                {person.feelingHistory.map((f) => (
                  <li key={f.id}>
                    {formatDateTime(f.createdAt)} · {FEELING_LABEL[f.value]}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="md:col-span-2">
            <CardTitle>平台账号</CardTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              同一对象可关联多个平台账号。关联由你确认，系统不会因为昵称相同而自动合并。
            </p>
            {person.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有关联账号。</p>
            ) : (
              <ul className="divide-y text-sm" data-testid="account-list">
                {person.accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <span>
                      <Badge className="mr-2">{PLATFORM_LABEL[a.platform]}</Badge>
                      {a.handle}
                    </span>
                    <form action={removeAccountAction.bind(null, id, a.id)}>
                      <Button type="submit" variant="ghost" size="sm" aria-label={`移除 ${a.handle}`}>
                        移除
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <AddAccountForm action={addAccountAction.bind(null, id)} />
          </Card>

          <Card className="border-red-200 md:col-span-2">
            <CardTitle>删除对象</CardTitle>
            <p className="mb-3 text-xs text-muted-foreground">将同时删除该对象的平台账号、好感记录，以及之后产生的聊天资料和分析结果。此操作无法撤销。</p>
            <form action={deletePersonAction.bind(null, id)}>
              <ConfirmButton variant="outline" className="border-red-300 text-red-700" message={`确定删除“${person.nickname}”及其全部资料吗？此操作无法撤销。`}>
                删除对象
              </ConfirmButton>
            </form>
          </Card>
        </div>
      )}

      {tab === "chats" && <EmptyState title="还没有聊天资料">聊天截图与文本导入将在下一阶段开放。</EmptyState>}
      {tab === "analysis" && <EmptyState title="暂无分析">导入聊天资料并点击“开始分析”后，报告与建议会显示在这里。</EmptyState>}
      {tab === "records" && <EmptyState title="暂无关系记录">线下事件、好感变化与分析快照的时间线将在后续阶段开放。</EmptyState>}
    </section>
  );
}
