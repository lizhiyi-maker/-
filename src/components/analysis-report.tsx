import { Badge, Card, CardTitle } from "@/components/ui/card";
import { messageTimeText } from "@/components/message-list";
import { FRESHNESS_LABEL, type Freshness } from "@/domain/analysis/freshness";
import { evidenceKey, type EvidenceRef, type ResolvedDimension, type SuggestionKind } from "@/domain/analysis/output";
import { EVENT_KIND_LABEL } from "@/domain/events";
import { DIMENSION_KEYS, dimensionLabel, levelLabel, RULES_EXPERIMENTAL, scoringRules } from "@/domain/analysis/rules";
import { SPEAKER_LABEL } from "@/domain/imports";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EvidenceEntry, ReportView } from "@/server/analysis/service";

const STATUS_LABEL = { known: "已知", clue: "线索", insufficient: "资料不足" } as const;
const STATUS_TONE = { known: "primary", clue: "warn", insufficient: "muted" } as const;
const KIND_LABEL: Record<SuggestionKind, string> = { ADVANCE: "推进", MAINTAIN: "保持", CLARIFY: "了解", RESPECT_BOUNDARY: "尊重边界" };

/** 一条证据：引用的消息（取自被引用的修订）及前后各一条上下文，或用户补充的线下事件（只有事实，不含个人感受）。 */
function EvidenceList({ refs, evidence }: { refs: EvidenceRef[]; evidence: Record<string, EvidenceEntry> }) {
  return (
    <ul className="mt-2 space-y-2" data-testid="evidence-list">
      {refs.map((r) => {
        const key = evidenceKey(r);
        const e = evidence[key];
        if (!e || e.unavailable) {
          return (
            <li key={key} className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {"eventId" in r ? "这条线下事件已被删除，无法再查看。" : "这条消息已被删除，无法再查看原文。"}
            </li>
          );
        }
        const edited = e.currentRevision !== null && e.currentRevision !== e.revision;
        if (e.source === "event") {
          return (
            <li key={key} className="rounded-md border bg-background px-3 py-2 text-xs" data-testid="evidence-event">
              <p className="font-medium">
                <Badge className="mr-1.5">线下事件{e.eventKind ? ` · ${EVENT_KIND_LABEL[e.eventKind]}` : ""}</Badge>
                <span className="text-muted-foreground">{e.occurredAt ? formatDate(e.occurredAt) : ""}</span>
                <span className="mt-1 block whitespace-pre-wrap break-words text-sm font-normal">{e.content}</span>
              </p>
              <p className="mt-1 text-muted-foreground">这是你自己记录的事实；你对它的个人感受不会作为证据，也不会发送给 AI 服务商。</p>
              {edited && <p className="mt-1 text-warn-foreground">这个事件在分析之后被你修改过，上面是分析当时看到的内容。</p>}
            </li>
          );
        }
        return (
          <li key={key} className="rounded-md border bg-background px-3 py-2 text-xs">
            {e.before && (
              <p className="text-muted-foreground">
                {SPEAKER_LABEL[e.before.speaker]}：{e.before.content}
              </p>
            )}
            <p className="my-1 font-medium">
              <Badge className="mr-1.5">{SPEAKER_LABEL[e.speaker]}</Badge>
              <span className="text-muted-foreground">{messageTimeText(e)}</span>
              <span className="mt-1 block whitespace-pre-wrap break-words text-sm font-normal">{e.content}</span>
            </p>
            {e.after && (
              <p className="text-muted-foreground">
                {SPEAKER_LABEL[e.after.speaker]}：{e.after.content}
              </p>
            )}
            {edited && <p className="mt-1 text-warn-foreground">这条消息在分析之后被你修改过，上面是分析当时看到的内容。</p>}
          </li>
        );
      })}
    </ul>
  );
}

function Facts({ title, items, evidence }: { title: string; items: { text: string; refs: EvidenceRef[] }[]; evidence: Record<string, EvidenceEntry> }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="mt-1 space-y-2 text-sm">
        {items.map((f, i) => (
          <li key={i}>
            <p>{f.text}</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-primary">查看证据（{f.refs.length} 条）</summary>
              <EvidenceList refs={f.refs} evidence={evidence} />
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dimension({ k, d, verification, evidence }: { k: string; d: ResolvedDimension; verification?: ReportView["verification"][string]; evidence: Record<string, EvidenceEntry> }) {
  const { minUnits, minDistinctContexts } = scoringRules.evidence.sufficient;
  return (
    <Card data-testid={`dimension-${k}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{dimensionLabel(k)}</h3>
        <div className="flex items-center gap-1.5">
          <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
          {d.status === "known" && d.level && <Badge tone="primary">等级建议：{levelLabel(d.level)}</Badge>}
        </div>
      </div>

      {d.status !== "known" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {d.status === "insufficient" ? "资料不足不等于低分，只是现有资料还看不出来。" : "线索只展示，不计入评分。"}
          {verification && ` 目前有 ${verification.units} 个独立证据单元、${verification.contexts} 个情境；标为“已知”需要至少 ${minUnits} 个单元且跨 ${minDistinctContexts} 个情境。`}
          {verification?.cappedBy === "CURATED_OR_UNCERTAIN" && " 这一维度含主动频率与稳定性，只有精选或不确定资料时最多到“线索”。"}
        </p>
      )}

      <Facts title="观察到的事实" items={d.observedFacts} evidence={evidence} />
      {d.interpretations.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-muted-foreground">可能的解读（不是结论）</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {d.interpretations.map((t, i) => (
              <li key={i}>{t.text}</li>
            ))}
          </ul>
        </div>
      )}
      <Facts title="支持的证据" items={d.supporting} evidence={evidence} />
      <Facts title="反面的证据" items={d.counter} evidence={evidence} />
      {d.missing.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-muted-foreground">缺失的信息</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {d.missing.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {d.userExperience.length > 0 && (
        <div className="mt-3 rounded-md bg-muted px-3 py-2">
          <h4 className="text-xs font-medium text-muted-foreground">你的体验（这是你的感受，不是对方的客观事实）</h4>
          <ul className="mt-1 space-y-1 text-sm">
            {d.userExperience.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function FreshnessBanner({ freshness }: { freshness: Freshness }) {
  const f = FRESHNESS_LABEL[freshness];
  return (
    <div role="status" data-testid="freshness" data-freshness={freshness} className={cn("rounded-lg border px-4 py-3 text-sm", freshness === "FRESH" ? "border-green-300 bg-green-50 text-green-900" : "border-warn bg-warn/20")}>
      <p className="font-medium">报告状态：{f.label}</p>
      <p className="mt-0.5 text-xs">{f.hint}</p>
    </div>
  );
}

/** 报告：当前结论、五维分析、可展开证据、最多三条行动建议、资料范围与规则版本。不展示成功概率或百分比。 */
export function AnalysisReport({ report, evidence, freshness }: { report: ReportView; evidence: Record<string, EvidenceEntry>; freshness: Freshness }) {
  const { output } = report;
  const kinds = report.batchSummary;
  return (
    <div className="space-y-4" data-testid="report">
      <FreshnessBanner freshness={freshness} />

      <Card>
        <CardTitle>当前结论</CardTitle>
        <p className="text-sm" data-testid="conclusion">
          {output.conclusion.summary}
        </p>
        {output.conclusion.stageSuggestion && (
          <p className="mt-2 text-xs text-muted-foreground">
            阶段建议（只是建议，由你确认）：{output.conclusion.stageSuggestion.reason}
          </p>
        )}
      </Card>

      {output.explicitRefusal.detected && (
        <div role="alert" data-testid="refusal-notice" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">对方明确表示不希望继续联系</p>
          <p className="mt-1 text-xs">因此这份报告不再提供追求或推进类建议，只提醒你尊重对方的意愿。是否把阶段改为“已结束”，由你自己决定。</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs">查看依据</summary>
            <EvidenceList refs={output.explicitRefusal.refs} evidence={evidence} />
          </details>
        </div>
      )}

      <section aria-label="五维分析" className="space-y-3">
        <h2 className="text-sm font-semibold">五维分析</h2>
        <p className="text-xs text-muted-foreground">
          这里展示每个维度的状态与等级建议和证据；具体分数在后续版本提供。信息充分度只描述资料覆盖与证据的限制，不是概率，也不预测结果。
        </p>
        {DIMENSION_KEYS.map((k) => (
          <Dimension key={k} k={k} d={output.dimensions[k]} verification={report.verification[k]} evidence={evidence} />
        ))}
      </section>

      <section aria-label="行动建议" className="space-y-3">
        <h2 className="text-sm font-semibold">行动建议（最多 3 条）</h2>
        {output.suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前没有合适的建议。</p>
        ) : (
          output.suggestions.map((s, i) => (
            <Card key={i} data-testid="suggestion">
              <div className="flex items-center gap-2">
                <Badge tone={s.kind === "RESPECT_BOUNDARY" ? "warn" : "primary"}>{KIND_LABEL[s.kind]}</Badge>
                <p className="text-sm font-medium">{s.text}</p>
              </div>
              <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div>
                  <dt className="inline font-medium">依据：</dt>
                  <dd className="inline">{s.basis}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">目的：</dt>
                  <dd className="inline">{s.purpose}</dd>
                </div>
                {s.unknowns.length > 0 && (
                  <div>
                    <dt className="inline font-medium">还不知道的：</dt>
                    <dd className="inline">{s.unknowns.join("；")}</dd>
                  </div>
                )}
              </dl>
              {s.refs.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-primary">查看依据的消息</summary>
                  <EvidenceList refs={s.refs} evidence={evidence} />
                </details>
              )}
            </Card>
          ))
        )}
      </section>

      <Card data-testid="report-scope" className="text-xs text-muted-foreground">
        <CardTitle>资料范围与版本</CardTitle>
        <ul className="space-y-1">
          <li>资料截止时间：{formatDateTime(report.snapshotAt)}（之后新增或修改的资料不在本报告内）</li>
          <li>
            共 {report.messageCount} 条消息：连续聊天 {kinds.CONTINUOUS} 批、精选片段 {kinds.CURATED} 批、不确定 {kinds.UNCERTAIN} 批
          </li>
          <li data-testid="report-event-scope">
            线下事件 {report.eventCount} 个（只发送事实；你的个人感受不会发送，也不参与分析）
          </li>
          <li>
            规则版本：{report.rulesVersion}
            {RULES_EXPERIMENTAL && <Badge tone="warn" className="ml-1.5">实验规则</Badge>}
          </li>
          <li>
            分析模型：{report.modelId} · 提示词版本：{report.promptVersion} · 个人偏好版本：{report.preferenceVersion}
          </li>
        </ul>
      </Card>
    </div>
  );
}
