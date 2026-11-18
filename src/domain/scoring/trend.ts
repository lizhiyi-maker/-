import { scoringRules, type ScoringRules } from "@/domain/analysis/rules";

export interface TrendSnapshot {
  id: string;
  snapshotAt: Date;
  rulesVersion: string;
  preferenceVersion: number;
  /** 适配分；未五维全已知时为 null */
  score: number | null;
}

export type TrendResult =
  /** 同口径的快照不足以比较 */
  | { kind: "INSUFFICIENT" }
  /** 与上一份相比规则或偏好版本不同：分差是口径变化，不是关系变化，不显示趋势 */
  | { kind: "BASELINE_CHANGED"; changed: ("rules" | "preference")[] }
  | { kind: "UP" | "DOWN" | "FLAT"; /** 窗口里最新与最早的分数之差 */ delta: number; points: { id: string; snapshotAt: Date; score: number }[] };

/**
 * 趋势（纯函数，规则见 rules-v0-experimental.md §7）：
 * 只比较与最新一份**同口径**（同规则版本、同偏好版本，由配置决定）且有适配分的快照，取最近至多 3 份、至少 2 份；
 * 最新与最早之差的绝对值 ≥ 8 分才标上升/下降，否则“基本持平/不足以判断”。
 * 同口径的快照不足、而上一份有分数的快照口径不同时，标“口径变化”，不显示趋势箭头。
 */
export function computeTrend(snapshots: TrendSnapshot[], rules: ScoringRules = scoringRules): TrendResult {
  const ordered = [...snapshots].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime() || a.id.localeCompare(b.id));
  const latest = ordered.at(-1);
  if (!latest || latest.score === null) return { kind: "INSUFFICIENT" };

  const { requireSameRuleVersion, requireSamePreferenceVersion, minComparableSnapshots, maxSnapshots, minDeltaPoints } = rules.trend;
  const scored = ordered.filter((s): s is TrendSnapshot & { score: number } => s.score !== null);
  const sameBaseline = (s: TrendSnapshot) => (!requireSameRuleVersion || s.rulesVersion === latest.rulesVersion) && (!requireSamePreferenceVersion || s.preferenceVersion === latest.preferenceVersion);

  const comparable = scored.filter(sameBaseline).slice(-maxSnapshots);
  if (comparable.length < minComparableSnapshots) {
    const previous = scored.at(-2);
    if (previous && !sameBaseline(previous)) {
      const changed: ("rules" | "preference")[] = [];
      if (requireSameRuleVersion && previous.rulesVersion !== latest.rulesVersion) changed.push("rules");
      if (requireSamePreferenceVersion && previous.preferenceVersion !== latest.preferenceVersion) changed.push("preference");
      return { kind: "BASELINE_CHANGED", changed };
    }
    return { kind: "INSUFFICIENT" };
  }

  const delta = Math.round((comparable.at(-1)!.score - comparable[0].score) * 10) / 10;
  return {
    kind: Math.abs(delta) >= minDeltaPoints ? (delta > 0 ? "UP" : "DOWN") : "FLAT",
    delta,
    points: comparable.map((s) => ({ id: s.id, snapshotAt: s.snapshotAt, score: s.score })),
  };
}
