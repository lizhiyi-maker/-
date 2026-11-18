import type { Freshness } from "@/domain/analysis/freshness";
import { scoringRules, type ScoringRules } from "@/domain/analysis/rules";
import { importanceOf, knownDimensions, weightedScore, type DimensionResults, type Importance } from "./score";

export type PersonStage = "JUST_MET" | "GETTING_TO_KNOW" | "IN_RELATIONSHIP" | "ENDED";

export interface RankingCandidate {
  id: string;
  stage: PersonStage | null;
  /** 最新报告里对方是否明确拒绝 */
  explicitRefusal: boolean;
  /** 最新报告的新鲜度；没有分析报告为 null */
  freshness: Freshness | null;
  /** 最新报告里各维度经程序核验后的状态与等级建议；没有分析报告为 null */
  dimensions: DimensionResults | null;
}

/** 不进入任何排名池的原因（仍可查看记录）。 */
export type ExcludedReason = "NO_ANALYSIS" | "NO_STAGE" | "STAGE_NOT_ELIGIBLE" | "EXPLICIT_REFUSAL" | "STALE_REPORT";
/** 入池后因关键证据不足而进入“待了解”的原因。 */
export type WaitingReason = "FEW_KNOWN" | "MISSING_CRITICAL" | "NOT_COMMON";

export interface RankedEntry {
  id: string;
  /** 同分并列同名次（1、1、3） */
  rank: number;
  tied: boolean;
  /** 在共同已知维度上按用户权重重新归一化后的分数 */
  score: number;
}

export interface PoolResult {
  stage: PersonStage;
  /** 参与排名的对象共同已知的维度；没有排名时为空 */
  commonDimensions: string[];
  ranked: RankedEntry[];
  /** 待了解：关键证据不足，不参与排名，只展示各自已知的维度 */
  waiting: { id: string; reason: WaitingReason; known: string[] }[];
  /** 池里没有可比较的对象（只有一个）：不排名，也不是“待了解” */
  unranked: { id: string; reason: "NO_PEERS" }[];
}

export interface Comparison {
  /** 每个有候选的阶段一个池；跨阶段不给统一名次 */
  pools: PoolResult[];
  excluded: { id: string; reason: ExcludedReason }[];
}

/** 这些新鲜度的报告已不能代表当前资料/口径，需先重新分析才能入池。“有新资料待分析”的报告仍然有效。 */
const STALE: Freshness[] = ["CORRECTED_EXPIRED", "PREFERENCE_CHANGED", "RULES_CHANGED"];

function excludedReason(c: RankingCandidate, rules: ScoringRules): ExcludedReason | null {
  if (!c.dimensions || c.freshness === null) return "NO_ANALYSIS";
  if (c.stage === null) return "NO_STAGE";
  if (!rules.ranking.eligibleStages.includes(c.stage)) return "STAGE_NOT_ELIGIBLE";
  if (c.explicitRefusal && rules.ranking.ineligibleFlags.includes("explicit_refusal")) return "EXPLICIT_REFUSAL";
  if (STALE.includes(c.freshness)) return "STALE_REPORT";
  return null;
}

/**
 * 排名与“待了解”（纯函数，规则见 docs/scoring/rules-v0-experimental.md §6）。
 * 1. 只有同阶段才比较：每个阶段各自成池，不同阶段不给统一名次。
 * 2. 准入：阶段为“刚认识/正在了解”、没有明确拒绝、报告不是需要重新分析的状态。
 * 3. 先把个体不合格的放进“待了解”（已知维度不足下限，或缺少重要程度为最高的维度），
 *    再对剩余对象求共同已知维度；共同维度不足下限则这些对象全部“待了解”。
 * 4. 在共同已知维度上按用户权重重新归一化后比较，同分并列同名次；缺失的维度不被当作 0 分。
 * 结果与候选的输入顺序无关（并列时按 id 排序）。
 */
export function buildComparison(candidates: RankingCandidate[], importance: Importance, rules: ScoringRules = scoringRules): Comparison {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const excluded: Comparison["excluded"] = [];
  const members = new Map<string, RankingCandidate[]>();
  for (const c of sorted) {
    const reason = excludedReason(c, rules);
    if (reason) excluded.push({ id: c.id, reason });
    else members.set(c.stage!, [...(members.get(c.stage!) ?? []), c]);
  }

  const critical = rules.dimensions.map((d) => d.key).filter((k) => importanceOf(importance, k, rules) >= rules.ranking.criticalImportance);
  const min = rules.ranking.minCommonKnownDimensions;
  const pools: PoolResult[] = [];

  for (const stage of rules.ranking.eligibleStages) {
    const group = members.get(stage);
    if (!group) continue;
    const pool: PoolResult = { stage, commonDimensions: [], ranked: [], waiting: [], unranked: [] };

    const remaining: { c: RankingCandidate; known: string[] }[] = [];
    for (const c of group) {
      const known = knownDimensions(c.dimensions!, rules);
      if (known.length < min) pool.waiting.push({ id: c.id, reason: "FEW_KNOWN", known });
      else if (critical.some((k) => !known.includes(k))) pool.waiting.push({ id: c.id, reason: "MISSING_CRITICAL", known });
      else remaining.push({ c, known });
    }

    if (remaining.length < 2) {
      for (const r of remaining) pool.unranked.push({ id: r.c.id, reason: "NO_PEERS" });
    } else {
      const common = rules.dimensions.map((d) => d.key).filter((k) => remaining.every((r) => r.known.includes(k)));
      if (common.length < min) {
        for (const r of remaining) pool.waiting.push({ id: r.c.id, reason: "NOT_COMMON", known: r.known });
      } else {
        pool.commonDimensions = common;
        const scored = remaining.map((r) => ({ id: r.c.id, score: weightedScore(r.c.dimensions!, common, importance, rules) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        pool.ranked = scored.map((s, i) => {
          const sameAsPrev = i > 0 && scored[i - 1].score === s.score;
          const sameAsNext = i < scored.length - 1 && scored[i + 1].score === s.score;
          const firstOfGroup = scored.findIndex((x) => x.score === s.score);
          return { id: s.id, score: s.score, rank: rules.ranking.tiesShareRank ? firstOfGroup + 1 : i + 1, tied: rules.ranking.tiesShareRank && (sameAsPrev || sameAsNext) };
        });
      }
    }
    pool.waiting.sort((a, b) => a.id.localeCompare(b.id));
    pools.push(pool);
  }
  return { pools, excluded };
}
