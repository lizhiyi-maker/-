import { Badge, Card, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

const KIND_LABEL = { ANALYSIS: "关系分析", RECOGNITION: "截图识别" } as const;
const STATUS_LABEL: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "运行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  INVALIDATED: "已作废",
  UPLOADED: "已上传",
  DONE: "已识别",
  SKIPPED: "已跳过",
};

const ms = (v: number | null) => (v === null ? "—" : v < 1000 ? `${v} 毫秒` : `${(v / 1000).toFixed(1)} 秒`);

function Counts({ title, counts, errors, testId }: { title: string; counts: Record<string, number>; errors: Record<string, number>; testId: string }) {
  const entries = Object.entries(counts);
  return (
    <Card data-testid={testId}>
      <CardTitle>{title}（近 24 小时）</CardTitle>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有任务。</p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {entries.map(([k, n]) => (
            <li key={k}>
              <Badge tone={k === "FAILED" ? "warn" : "muted"}>
                {STATUS_LABEL[k] ?? k} {n}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {Object.keys(errors).length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          失败原因：{Object.entries(errors).map(([code, n]) => `${code} × ${n}`).join("；")}
        </p>
      )}
    </Card>
  );
}

/** 任务状态：只读，不含聊天内容，没有重试/取消/退款操作。 */
export default async function AdminTasksPage() {
  const admin = await requireAdmin();
  const t = await getServices().admin.taskStatus(admin.id);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">只读。只显示状态、时间、错误码和脱敏手机号，不显示聊天内容；这里没有重试、取消或退款操作，额度调整请在“用户与额度”里按流程处理。</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Counts title="关系分析" counts={t.analysis.counts} errors={t.analysis.errorCodes} testId="tasks-analysis" />
        <Counts title="截图识别" counts={t.recognition.counts} errors={t.recognition.errorCodes} testId="tasks-recognition" />
      </div>

      <Card data-testid="tasks-stuck">
        <CardTitle>卡住的任务（排队/运行超过 {t.stuckAfterMinutes} 分钟）</CardTitle>
        {t.stuck.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有。</p>
        ) : (
          <ul className="divide-y text-sm">
            {t.stuck.map((s) => (
              <li key={s.id} className="py-2">
                {KIND_LABEL[s.kind]} · {STATUS_LABEL[s.status]} · 已 {s.ageMinutes} 分钟 · <span className="font-mono">{s.userPhoneMasked}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">worker 每 5 分钟会把这类任务判为失败并退还额度。</p>
      </Card>

      <Card className="overflow-x-auto" data-testid="tasks-recent">
        <CardTitle>最近 50 条任务</CardTitle>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">类型</th>
              <th className="pr-3">状态</th>
              <th className="pr-3">错误码</th>
              <th className="pr-3">提交时间</th>
              <th className="pr-3">耗时</th>
              <th>用户</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {t.recent.map((r) => (
              <tr key={`${r.kind}-${r.id}`} data-testid="task-row">
                <td className="py-2 pr-3">{KIND_LABEL[r.kind]}</td>
                <td className="pr-3">{STATUS_LABEL[r.status] ?? r.status}</td>
                <td className="pr-3 font-mono text-xs">{r.errorCode ?? "—"}</td>
                <td className="pr-3">{formatDateTime(r.queuedAt)}</td>
                <td className="pr-3">{ms(r.durationMs)}</td>
                <td className="font-mono text-xs">{r.userPhoneMasked}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.recent.length === 0 && <p className="py-3 text-sm text-muted-foreground">还没有任务。</p>}
      </Card>
    </div>
  );
}
