import Link from "next/link";
import { createEventAction, deleteEventAction, updateEventAction } from "@/app/actions/events";
import { ConfirmButton } from "@/components/confirm-button";
import { EventForm } from "@/components/event-form";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui/card";
import { EVENT_KIND_LABEL, toDateInput, todayInBeijing } from "@/domain/events";
import { FEELING_LABEL } from "@/domain/people";
import { buildTimeline, type TimelineEventInput } from "@/domain/timeline";
import { formatDate, formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";

/**
 * 对象详情“关系记录”：补充线下事件，并把线下事件、好感变化、分析快照放在同一条时间线上复盘。
 * 事实与个人感受分开展示；“我的好感”和个人感受只展示，不参与评分。
 */
export async function RecordsPanel({ userId, personId, editId }: { userId: string; personId: string; editId?: string }) {
  const { events: eventsService, people, analysis } = getServices();
  const [events, person, snapshots] = await Promise.all([eventsService.list(userId, personId), people.get(userId, personId), analysis.listSnapshots(userId, personId)]);
  const today = todayInBeijing(new Date());
  const items = buildTimeline({
    events: events.map((e): TimelineEventInput => ({ id: e.id, kind: e.kind, occurredOn: e.occurredOn, facts: e.facts, personalNote: e.personalNote, revision: e.revision })),
    feelings: person.feelingHistory.map((f) => ({ id: f.id, value: f.value, createdAt: f.createdAt })),
    snapshots,
  });
  const base = `/people/${personId}?tab=records`;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>补充一个线下事件</CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">见面、通话、取消安排或其他你想补充的事实。事实和你的感受分开记录：只有事实会参与分析。</p>
        <EventForm action={createEventAction.bind(null, personId)} initial={{ kind: "MEET", occurredOn: today, facts: "", personalNote: "" }} maxDate={today} submitLabel="记录事件" />
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">时间线</h2>
        {items.length === 0 ? (
          <EmptyState title="还没有记录">补充线下事件、修改“我的好感”或完成分析后，它们会按时间排在这里。</EmptyState>
        ) : (
          <ol className="space-y-3" data-testid="timeline">
            {items.map((item) => {
              if (item.type === "event") {
                const e = item.event;
                if (item.id === editId) {
                  return (
                    <li key={`e-${item.id}`}>
                      <Card className="border-primary" data-testid="timeline-event-editing">
                        <CardTitle>修改事件</CardTitle>
                        <p className="mb-3 text-xs text-muted-foreground">修改事实会产生新的版本；引用了旧版本的报告会提示“资料纠正已过期”。只改“我的感受”不影响报告。</p>
                        <EventForm
                          action={updateEventAction.bind(null, personId, e.id)}
                          initial={{ kind: e.kind, occurredOn: toDateInput(e.occurredOn), facts: e.facts, personalNote: e.personalNote ?? "" }}
                          maxDate={today}
                          submitLabel="保存修改"
                          cancelHref={base}
                        />
                      </Card>
                    </li>
                  );
                }
                return (
                  <li key={`e-${item.id}`}>
                    <Card data-testid="timeline-event">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm">
                          <Badge tone="primary">线下事件 · {EVENT_KIND_LABEL[e.kind]}</Badge>
                          <span className="text-muted-foreground">{formatDate(e.occurredOn)}</span>
                          {e.revision > 1 && <span className="text-xs text-muted-foreground">事实已修改 {e.revision - 1} 次</span>}
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <Link href={`${base}&edit=${e.id}`} className="text-primary">
                            编辑
                          </Link>
                          <form action={deleteEventAction.bind(null, personId, e.id)}>
                            <ConfirmButton variant="ghost" size="sm" className="text-red-700" message="确定删除这个事件吗？引用了它的旧报告会提示“资料纠正已过期”。此操作无法撤销。">
                              删除
                            </ConfirmButton>
                          </form>
                        </div>
                      </div>
                      <div className="mt-2 text-sm">
                        <h3 className="text-xs font-medium text-muted-foreground">事实</h3>
                        <p className="whitespace-pre-wrap break-words" data-testid="event-facts">
                          {e.facts}
                        </p>
                      </div>
                      {e.personalNote && (
                        <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm" data-testid="event-note">
                          <h3 className="text-xs font-medium text-muted-foreground">我的感受（只有你自己能看到，不发送给 AI 服务商，不是对方的客观事实）</h3>
                          <p className="whitespace-pre-wrap break-words">{e.personalNote}</p>
                        </div>
                      )}
                    </Card>
                  </li>
                );
              }

              if (item.type === "feeling") {
                return (
                  <li key={`f-${item.id}`}>
                    <Card data-testid="timeline-feeling">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge>我的好感</Badge>
                        <span>
                          {item.from ? `${FEELING_LABEL[item.from]} → ` : "记录为 "}
                          <span className="font-medium">{FEELING_LABEL[item.value]}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(item.at)}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">只由你填写，不参与系统评分。</p>
                    </Card>
                  </li>
                );
              }

              const s = item.snapshot;
              return (
                <li key={`a-${item.id}`}>
                  <Card data-testid="timeline-analysis">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="warn">分析快照</Badge>
                      <span className="text-xs text-muted-foreground">资料截止 {formatDateTime(s.snapshotAt)}</span>
                      {item.baselineChanged && (
                        <Badge tone="warn" data-testid="baseline-changed">
                          口径变化
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 text-sm">{s.summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.messageCount} 条消息、{s.eventCount} 个线下事件 · 规则 {s.rulesVersion} · 偏好版本 {s.preferenceVersion}
                    </p>
                    {item.baselineChanged && (
                      <p className="mt-1 text-xs text-muted-foreground">与上一份分析相比，规则或偏好版本不同：两份报告的差异可能来自口径变化，不能解释为关系升温或降温。</p>
                    )}
                  </Card>
                </li>
              );
            })}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          最新的报告在
          <Link href={`/people/${personId}?tab=analysis`} className="text-primary">
            “分析与建议”
          </Link>
          里查看；这里保留每次分析当时的结论摘要，方便复盘。
        </p>
      </div>
    </div>
  );
}
