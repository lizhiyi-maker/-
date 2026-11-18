import Link from "next/link";
import { startAnalysisAction } from "@/app/actions/analysis";
import { ActionButton } from "@/components/action-button";
import { AnalysisReport, FreshnessBanner } from "@/components/analysis-report";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConsentCard } from "@/components/consent-card";
import { TrendCard } from "@/components/fit-score";
import { Card, CardTitle, EmptyState } from "@/components/ui/card";
import { getServices } from "@/server/container";

/** 对象详情“分析与建议”：同意 → 开始分析 → 进度 → 报告。新增资料不会自动分析，由用户决定何时（重新）分析。 */
export async function AnalysisPanel({ userId, personId }: { userId: string; personId: string }) {
  const { analysis, compare, consent, provider, db } = getServices();
  const [report, consentStatus, confirmedCount] = await Promise.all([
    analysis.getReport(userId, personId),
    consent.status(userId),
    db.message.count({ where: { userId, personId, state: "CONFIRMED" } }),
  ]);
  const evidence = report.latest ? await analysis.loadEvidence(userId, report.latest.id) : {};
  const trend = report.latest ? (await compare.trend(userId, personId)).trend : null;

  const starter = !consentStatus.accepted ? (
    <ConsentCard provider={provider} action="关系分析" />
  ) : confirmedCount === 0 ? (
    <EmptyState title="还没有可以分析的资料">
      先<Link href={`/people/${personId}/import/new`} className="text-primary">导入聊天资料</Link>并确认保存，再回来开始分析。
    </EmptyState>
  ) : report.running ? null : (
    <Card>
      <CardTitle>{report.latest ? "重新分析" : "开始分析"}</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">
        分析会把你已保存的聊天文字发送给 AI 服务商，消耗 1 次分析额度（失败不扣）。分析在后台进行，你可以离开页面稍后回来。
      </p>
      <ActionButton action={startAnalysisAction.bind(null, personId)} size="lg" className="w-full" pendingText="正在提交…">
        {report.latest ? "重新分析" : "开始分析"}
      </ActionButton>
    </Card>
  );

  return (
    <div className="space-y-4">
      <AutoRefresh active={report.running !== null} />
      {report.running && (
        <Card className="border-primary" data-testid="analysis-running">
          <CardTitle>正在分析…</CardTitle>
          <p className="text-sm text-muted-foreground">分析在后台进行，你可以离开这个页面，稍后回来查看；刷新页面进度不会丢失。{report.latest ? "下面是上一次的报告，仍可查看。" : ""}</p>
        </Card>
      )}
      {report.latest && report.freshness ? (
        <>
          <AnalysisReport report={report.latest} evidence={evidence} freshness={report.freshness} />
          {trend && <TrendCard trend={trend} />}
        </>
      ) : (
        report.freshness && <FreshnessBanner freshness={report.freshness} />
      )}
      {starter}
    </div>
  );
}
