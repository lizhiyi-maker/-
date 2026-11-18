import { Badge, Card, CardTitle } from "@/components/ui/card";
import { costPricing, formatYuan, USAGE_KIND_LABEL, type UsageTotals } from "@/domain/cost";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";

const DAYS = 30;
const cost = (t: UsageTotals) => (t.unknownCostCalls === t.calls && t.calls > 0 ? "无法估算" : formatYuan(t.costMicroYuan)) + (t.unknownCostCalls > 0 && t.unknownCostCalls < t.calls ? `（另有 ${t.unknownCostCalls} 次无法估算）` : "");

function Table({ title, rows, testId }: { title: string; rows: { label: string; t: UsageTotals }[]; testId: string }) {
  return (
    <Card className="overflow-x-auto" data-testid={testId}>
      <CardTitle>{title}</CardTitle>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3" />
            <th className="pr-3">调用</th>
            <th className="pr-3">失败</th>
            <th className="pr-3">输入/输出 token</th>
            <th className="pr-3">耗时</th>
            <th>估算成本</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ label, t }) => (
            <tr key={label} data-testid="cost-row">
              <td className="py-2 pr-3">{label}</td>
              <td className="pr-3">{t.calls}</td>
              <td className="pr-3">{t.failures}</td>
              <td className="pr-3">
                {t.inputTokens}/{t.outputTokens}
              </td>
              <td className="pr-3">{(t.durationMs / 1000).toFixed(1)} 秒</td>
              <td>{cost(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="py-3 text-sm text-muted-foreground">没有记录。</p>}
    </Card>
  );
}

/** 成本：模型调用的用量与估算成本。只含用量与成本，不含任何聊天内容。 */
export default async function AdminCostsPage() {
  const admin = await requireAdmin();
  const s = await getServices().admin.costSummary(admin.id, DAYS);
  const avg = s.perAnalysis;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">最近 {DAYS} 天。成本 = 服务商返回的 token 用量 × config/cost.json 的单价；缺少用量或单价时显示“无法估算”，不会猜。</p>
      {!costPricing.pricesVerified && (
        <div role="status" className="rounded-lg border border-warn bg-warn/20 px-4 py-3 text-sm" data-testid="prices-unverified">
          <Badge tone="warn">单价未核实</Badge> {costPricing.notice}
        </div>
      )}
      {s.allSimulated && (
        <div role="status" className="rounded-lg border px-4 py-3 text-sm" data-testid="all-simulated">
          当前所有调用都来自<strong>模拟模型</strong>：没有真实的用量与成本。真实服务商接入并核实单价后，这里才是真实成本。
        </div>
      )}
      <Card data-testid="cost-average">
        <CardTitle>每次分析的平均成本</CardTitle>
        <p className="text-2xl font-semibold">{avg.averageMicroYuan === null ? "无法估算" : formatYuan(avg.averageMicroYuan)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          共 {avg.analyses} 次分析，其中 {avg.withKnownCost} 次所有调用的成本都已知。{s.allSimulated ? "（模拟模型，成本记为 0。）" : ""}
        </p>
      </Card>
      <Table title="合计" testId="cost-total" rows={[{ label: "全部", t: s.total }]} />
      <Table title="按类型" testId="cost-by-kind" rows={s.byKind.map((k) => ({ label: USAGE_KIND_LABEL[k.kind], t: k }))} />
      <Table title="按模型" testId="cost-by-model" rows={s.byModel.map((m) => ({ label: `${m.modelId}${m.simulated ? "（模拟）" : ""}`, t: m }))} />
      <Table title="按天（北京时间）" testId="cost-by-day" rows={s.byDay.map((d) => ({ label: d.day, t: d }))} />
    </div>
  );
}
