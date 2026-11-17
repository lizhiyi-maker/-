import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  acceptMessageAction,
  confirmBatchAction,
  confirmIdentityAction,
  deleteBatchAction,
  discardMessageAction,
  editMessageAction,
  setDataKindAction,
  setLabelRoleAction,
  setSpeakerAction,
  swapSpeakersAction,
} from "@/app/actions/imports";
import { ConfirmButton } from "@/components/confirm-button";
import { ConfirmImportForm } from "@/components/confirm-import-form";
import { messageTimeText } from "@/components/message-list";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle } from "@/components/ui/card";
import { Select, Textarea } from "@/components/ui/form-controls";
import { DATA_KIND_LABEL, SPEAKER_LABEL } from "@/domain/imports";
import { PLATFORM_LABEL } from "@/domain/people";
import { cn } from "@/lib/utils";
import { NotFoundError } from "@/server/errors";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

export default async function ImportConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; batchId: string }>;
  searchParams: Promise<{ swapped?: string; overlap?: string }>;
}) {
  const { id, batchId } = await params;
  const { swapped, overlap } = await searchParams;
  const user = await requireUser();
  const preview = await getServices()
    .imports.getPreview(user.id, batchId)
    .catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!preview || preview.batch.personId !== id) notFound();
  if (preview.batch.status === "CONFIRMED") redirect(`/people/${id}?tab=chats`);

  const { batch, labels, messages } = preview;
  const hasRole = labels.some((l) => l.role !== null);
  const prefilledUnconfirmed = labels.every((l) => l.role !== null) && !batch.identityConfirmed;
  const uncertain = messages.filter((m) => m.recognition === "UNCERTAIN");
  const [overlapBefore, overlapAfter] = (overlap ?? "").split("-");

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <Link href={`/people/${id}?tab=chats`} className="text-sm text-muted-foreground">
        ← 返回聊天资料
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">确认导入的聊天</h1>
        <Badge>{PLATFORM_LABEL[batch.platform]}</Badge>
        <Badge tone="primary">共 {messages.length} 条</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        整理结果还没有保存。请确认“我/对方”、处理不确定的内容后再保存；保存前不会进入你的聊天资料，也不会触发分析。
      </p>

      {swapped && (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="swap-notice">
          已交换 {swapped} 条消息的“我/对方”。
          {overlapBefore !== undefined && overlapAfter !== undefined && ` 与已保存聊天的重叠由 ${overlapBefore} 条变为 ${overlapAfter} 条。`}
        </p>
      )}

      <Card>
        <CardTitle>资料类型</CardTitle>
        <form action={setDataKindAction.bind(null, id, batchId)} className="flex gap-2">
          <Select name="dataKind" aria-label="资料类型" defaultValue={batch.dataKind}>
            {Object.entries(DATA_KIND_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline">
            更新
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">精选片段和不确定资料不能直接用来判断整段关系的主动频率与稳定性。</p>
      </Card>

      <Card>
        <CardTitle>1. 谁是你？</CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">必须由你确认，不能凭名字或位置猜测。</p>
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有识别出发言人名称。</p>
        ) : (
          <ul className="space-y-2" data-testid="label-roles">
            {labels.map((l) => (
              <li key={l.label} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <span className="text-sm">
                  “{l.label}” <span className="text-xs text-muted-foreground">{l.count} 条</span>
                </span>
                <span className="flex gap-1" role="group" aria-label={`${l.label} 的身份`}>
                  {(["SELF", "OTHER"] as const).map((role) => (
                    <form key={role} action={setLabelRoleAction.bind(null, id, batchId, l.label, role)}>
                      <Button
                        type="submit"
                        size="sm"
                        variant={l.role === role ? "default" : "outline"}
                        aria-pressed={l.role === role}
                        aria-label={`将“${l.label}”设为${SPEAKER_LABEL[role]}`}
                      >
                        {SPEAKER_LABEL[role]}
                      </Button>
                    </form>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={swapSpeakersAction.bind(null, id, batchId)}>
            <Button type="submit" variant="outline" size="sm" disabled={!hasRole}>
              交换“我/对方”
            </Button>
          </form>
          {prefilledUnconfirmed && (
            <form action={confirmIdentityAction.bind(null, id, batchId)}>
              <Button type="submit" size="sm">
                已按上次设置预填，确认无误
              </Button>
            </form>
          )}
        </div>
      </Card>

      {uncertain.length > 0 && (
        <Card className="border-warn" data-testid="uncertain-section">
          <CardTitle>2. 需要你确认的内容（{uncertain.length}）</CardTitle>
          <p className="mb-3 text-xs text-muted-foreground">系统无法确定这些内容，不会替你猜测。</p>
          <ul className="space-y-3">
            {uncertain.map((m) => (
              <li key={m.id} className="rounded-md border p-3 text-sm">
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
                <p className="mt-1 text-xs text-muted-foreground">{m.uncertainReason}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(["SELF", "OTHER"] as const).map((s) => (
                    <form key={s} action={setSpeakerAction.bind(null, id, batchId, m.id, s)}>
                      <Button type="submit" size="sm" variant="outline">
                        这是{SPEAKER_LABEL[s]}说的
                      </Button>
                    </form>
                  ))}
                  <form action={acceptMessageAction.bind(null, id, batchId, m.id)}>
                    <Button type="submit" size="sm" variant="outline">
                      按原样保留
                    </Button>
                  </form>
                  <form action={discardMessageAction.bind(null, id, batchId, m.id)}>
                    <Button type="submit" size="sm" variant="ghost">
                      丢弃
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardTitle>{uncertain.length > 0 ? "3." : "2."} 核对消息</CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">可以修改任何一条的文字或发言人。没有可靠时间的消息不会被猜测时间，也不会用来计算回复速度。</p>
        <ol className="space-y-2" data-testid="preview-list">
          {messages.map((m) => (
            <li key={m.id} className={cn("rounded-md border p-3 text-sm", m.duplicateOfId && "border-warn bg-warn/10")}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge tone={m.speaker === "UNKNOWN" ? "warn" : "muted"}>{SPEAKER_LABEL[m.speaker]}</Badge>
                <span>{messageTimeText(m)}</span>
                {m.type !== "TEXT" && <Badge>{m.type === "IMAGE" ? "图片（内容未提供）" : m.type === "VOICE" ? "语音（内容未提供）" : m.type === "SYSTEM" ? "系统提示" : "其他类型"}</Badge>}
                {m.duplicateOfId && <Badge tone="warn">与已保存的聊天重复</Badge>}
                {m.recognition === "USER_EDITED" && <Badge tone="primary">已修改</Badge>}
              </div>
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-primary">编辑</summary>
                <form action={editMessageAction.bind(null, id, batchId, m.id)} className="mt-2 space-y-2">
                  <Textarea name="content" aria-label="消息内容" defaultValue={m.content} className="min-h-16" />
                  <Select name="speaker" aria-label="发言人" defaultValue={m.speaker}>
                    <option value="SELF">我</option>
                    <option value="OTHER">对方</option>
                    <option value="UNKNOWN">未确认</option>
                  </Select>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm">
                      保存修改
                    </Button>
                  </div>
                </form>
                <form action={discardMessageAction.bind(null, id, batchId, m.id)} className="mt-2">
                  <Button type="submit" size="sm" variant="ghost">
                    丢弃这条
                  </Button>
                </form>
              </details>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <CardTitle>保存</CardTitle>
        <ConfirmImportForm
          action={confirmBatchAction.bind(null, id, batchId)}
          canConfirm={preview.canConfirm}
          blockers={preview.blockers}
          overlapCount={preview.overlapCount}
        />
      </Card>

      <form action={deleteBatchAction.bind(null, id, batchId, "person")}>
        <ConfirmButton variant="ghost" className="w-full text-red-700" message="放弃这批资料吗？已整理的内容会被删除。">
          放弃这批资料
        </ConfirmButton>
      </form>
    </section>
  );
}
