import { Badge, Card, CardTitle } from "@/components/ui/card";
import { DIMENSION_KEYS, dimensionLabel, levelLabel, RULES_EXPERIMENTAL } from "@/domain/analysis/rules";
import { trendText } from "@/domain/scoring/labels";
import type { DimensionResults, FitScore, Importance } from "@/domain/scoring/score";
import type { TrendResult } from "@/domain/scoring/trend";

const STATUS_LABEL = { known: "已知", clue: "线索（不计分）", insufficient: "资料不足" } as const;

/** 一个维度在对比/评分里的展示：已知显示等级；线索与资料不足是状态，不是分数。 */
export function dimensionCell(d: DimensionResults[string]): string {
  if (!d) return "资料不足";
  if (d.status === "known" && d.level) return levelLabel(d.level);
  return STATUS_LABEL[d.status];
}

/**
 * 评分与信息充分度：只有五个维度都“已知”才显示适配分，否则只列出各维度的状态与等级，并说明原因。
 * 适配分表示这段互动与你期待的适配程度；不是对人的评价，不预测结果，也没有百分比或概率。
 */
export function FitScoreCard({ fit, dimensions, importance }: { fit: FitScore; dimensions: DimensionResults; importance: Importance }) {
  return (
    <Card data-testid="fit-score">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="mb-0">适配分</CardTitle>
        {RULES_EXPERIMENTAL && <Badge tone="warn">实验规则</Badge>}
      </div>
      {fit.kind === "scored" ? (
        <p className="mt-2 text-sm">
          <span className="text-3xl font-semibold" data-testid="fit-score-value">
            {fit.score}
          </span>
          <span className="ml-2 text-muted-foreground">分（0–100）</span>
        </p>
      ) : (
        <p className="mt-2 text-sm" data-testid="fit-score-none">
          暂不显示适配分：还有 {fit.notKnown.length} 个维度（{fit.notKnown.map(dimensionLabel).join("、")}）不是“已知”。资料不足不等于 0 分，也不会被忽略后放大其余维度的得分。
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        表示这段互动与你的期待的适配程度，不评价对方的价值，也不预测恋爱结果。分数由程序按规则版本和你的偏好，依据下面各维度的等级计算，AI 只提供等级建议；你的“我的好感”和个人感受不参与计算。
      </p>
      <ul className="mt-3 divide-y text-sm" data-testid="fit-score-dimensions">
        {DIMENSION_KEYS.map((k) => (
          <li key={k} className="flex items-center justify-between gap-2 py-1.5">
            <span>
              {dimensionLabel(k)}
              <span className="ml-2 text-xs text-muted-foreground">重要程度 {importance[k] ?? 3}</span>
            </span>
            <Badge tone={dimensions[k]?.status === "known" ? "primary" : "muted"}>{dimensionCell(dimensions[k])}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 趋势：只比较同规则版本、同偏好版本的分析；口径变化只标注，不显示升降。 */
export function TrendCard({ trend }: { trend: TrendResult }) {
  const t = trendText(trend);
  return (
    <Card data-testid="trend-card" data-trend={trend.kind}>
      <CardTitle>趋势</CardTitle>
      <p className="text-sm font-medium">{t.label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
      {(trend.kind === "UP" || trend.kind === "DOWN" || trend.kind === "FLAT") && (
        <p className="mt-2 text-xs text-muted-foreground">适配分：{trend.points.map((p) => p.score).join(" → ")}</p>
      )}
    </Card>
  );
}
