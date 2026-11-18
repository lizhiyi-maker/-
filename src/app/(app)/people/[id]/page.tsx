import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteBatchAction, setDataKindAction } from "@/app/actions/imports";
import {
  addAccountAction,
  deletePersonAction,
  removeAccountAction,
  setFeelingAction,
} from "@/app/actions/people";
import { AddAccountForm } from "@/components/account-form";
import { AnalysisPanel } from "@/components/analysis-panel";
import { ConfirmButton } from "@/components/confirm-button";
import { MessageList } from "@/components/message-list";
import { RecordsPanel } from "@/components/records-panel";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui/card";
import { Select } from "@/components/ui/form-controls";
import { BATCH_STATUS_LABEL, DATA_KIND_HINT, DATA_KIND_LABEL } from "@/domain/imports";
import { FEELING_LABEL, GENDER_LABEL, PLATFORM_LABEL, STAGE_LABEL } from "@/domain/people";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getServices } from "@/server/container";
import { isNotFound } from "@/server/errors";
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
  searchParams: Promise<{ tab?: string; batch?: string; saved?: string; merged?: string; edit?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab, batch: batchParam, saved, merged, edit } = await searchParams;
  const tab = TABS.find((t) => t.key === rawTab)?.key ?? "overview";
  const user = await requireUser();
  const person = await getServices()
    .people.get(user.id, id)
    .catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
  if (!person) notFound();

  const { imports } = getServices();
  const chats =
    tab === "chats"
      ? {
          batches: await imports.listBatches(user.id, id),
          pending: (await imports.listPending(user.id)).filter((b) => b.personId === id),
        }
      : null;
  const openBatch = chats?.batches.find((b) => b.id === batchParam) ?? null;
  const openMessages = openBatch ? await imports.listMessages(user.id, openBatch.id) : [];

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

      {tab === "chats" && chats && (
        <div className="space-y-4">
          {saved !== undefined && (
            <Card className="border-green-300 bg-green-50" data-testid="saved-notice">
              <p className="text-sm font-medium text-green-800">
                已保存 {saved} 条消息{Number(merged) > 0 ? `，合并了 ${merged} 条重复消息` : ""}。
              </p>
              <p className="mt-1 text-xs text-green-800/80">新增资料不会自动分析。准备好之后，由你决定何时开始分析。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/people/${id}/import/new`} className="inline-flex h-10 items-center rounded-md border bg-card px-4 text-sm font-medium">
                  继续添加资料
                </Link>
                <Link href={`/people/${id}?tab=analysis`} className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                  开始分析
                </Link>
              </div>
            </Card>
          )}

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">聊天资料</h2>
            <div className="flex items-center gap-2">
              <a href={`/api/export/people/${id}/chat`} download className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm" data-testid="export-chat-link">
                下载聊天文本
              </a>
              <Link href={`/people/${id}/import/new`} className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
                导入聊天资料
              </Link>
            </div>
          </div>

          {chats.pending.length > 0 && (
            <Card className="border-warn" data-testid="pending-batches">
              <CardTitle>待确认</CardTitle>
              <ul className="divide-y text-sm">
                {chats.pending.map((b) => (
                  <li key={b.id} className="flex items-center justify-between py-2">
                    <span>
                      {BATCH_STATUS_LABEL[b.status]} · {b.messageCount} 条 · {formatDateTime(b.createdAt)}
                    </span>
                    <Link href={`/people/${id}/import/${b.id}`} className="text-primary">
                      继续确认
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {chats.batches.length === 0 && chats.pending.length === 0 ? (
            <EmptyState title="还没有聊天资料">点击“导入聊天资料”，粘贴你们的聊天文本。保存之前，你可以先核对和修改。</EmptyState>
          ) : (
            <ul className="space-y-3" data-testid="batch-list">
              {chats.batches.map((b) => (
                <li key={b.id}>
                  <Card>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-sm">
                        <Badge>{PLATFORM_LABEL[b.platform]}</Badge>
                        <Badge tone="primary">{DATA_KIND_LABEL[b.dataKind]}</Badge>
                        <span>{b.messageCount} 条</span>
                        <span className="text-xs text-muted-foreground">{b.confirmedAt ? formatDateTime(b.confirmedAt) : ""}</span>
                      </div>
                      <Link
                        href={b.id === batchParam ? `/people/${id}?tab=chats` : `/people/${id}?tab=chats&batch=${b.id}`}
                        className="text-sm text-primary"
                      >
                        {b.id === batchParam ? "收起" : "查看"}
                      </Link>
                    </div>
                    {b.dataKind !== "CONTINUOUS" && <p className="mt-2 text-xs text-muted-foreground">{DATA_KIND_HINT[b.dataKind]}</p>}
                    {b.id === batchParam && (
                      <div className="mt-4 space-y-4 border-t pt-4">
                        <MessageList messages={openMessages} />
                        <form action={setDataKindAction.bind(null, id, b.id)} className="flex gap-2">
                          <Select name="dataKind" aria-label="资料类型" defaultValue={b.dataKind}>
                            {Object.entries(DATA_KIND_LABEL).map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </Select>
                          <Button type="submit" variant="outline">
                            更新资料类型
                          </Button>
                        </form>
                        <form action={deleteBatchAction.bind(null, id, b.id, "person")}>
                          <ConfirmButton variant="outline" className="border-red-300 text-red-700" message="确定删除这批资料吗？其中的消息与修订都会被删除，此操作无法撤销。">
                            删除这批资料
                          </ConfirmButton>
                        </form>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === "analysis" && <AnalysisPanel userId={user.id} personId={id} />}
      {tab === "records" && <RecordsPanel userId={user.id} personId={id} editId={edit} />}
    </section>
  );
}
