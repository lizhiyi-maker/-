import { scoringRules, type ScoringRules } from "@/domain/analysis/rules";

/** 分析结果里一个维度经程序核验后的状态与等级建议（见 AnalysisOutput.dimensions）。 */
export interface DimensionResult {
  status: "known" | "clue" | "insufficient";
  level?: string;
}
export type DimensionResults = Record<string, DimensionResult | undefined>;

/** 用户的维度重要程度（1–5）。缺少的维度使用默认值。 */
export type Importance = Record<string, number>;

const pointsOf = (level: string, rules: ScoringRules) => rules.levels.find((l) => l.key === level)?.score;

/**
 * 一个维度是否“已知”：状态为已知，且带有配置里的合法等级。
 * 没有合法等级的“已知”不能计分；非“已知”维度即使带着等级也被忽略（资料不足不是 0 分）。
 */
export function isKnown(d: DimensionResult | undefined, rules: ScoringRules = scoringRules): boolean {
  return d?.status === "known" && d.level !== undefined && pointsOf(d.level, rules) !== undefined;
}

/** 已知的维度（按配置里的维度顺序）。 */
export function knownDimensions(dims: DimensionResults, rules: ScoringRules = scoringRules): string[] {
  return rules.dimensions.map((d) => d.key).filter((k) => isKnown(dims[k], rules));
}

export function importanceOf(importance: Importance, key: string, rules: ScoringRules = scoringRules): number {
  const v = importance[key];
  return Number.isInteger(v) && v >= rules.importance.min && v <= rules.importance.max ? v : rules.importance.default;
}

/**
 * 在给定维度上的加权平均：权重 = 该维度重要程度 ÷ 这些维度重要程度之和，按配置的小数位四舍五入（中点向上）。
 * 调用方保证 keys 都是“已知”维度。
 */
export function weightedScore(dims: DimensionResults, keys: string[], importance: Importance, rules: ScoringRules = scoringRules): number {
  let num = 0;
  let den = 0;
  for (const k of keys) {
    const imp = importanceOf(importance, k, rules);
    num += imp * pointsOf(dims[k]!.level!, rules)!;
    den += imp;
  }
  const factor = 10 ** rules.total.scoreDecimals;
  // num、den 都是由整数/配置值得到的有限小数；商恰在中点时 IEEE 除法是精确的，中点向上取整
  return Math.round((num * factor) / den) / factor;
}

export type FitScore =
  | { kind: "scored"; score: number; /** 计算时使用的重要程度（含默认值补全） */ importance: Importance }
  | { kind: "unscored"; known: string[]; /** 不是“已知”的维度（线索或资料不足） */ notKnown: string[] };

/**
 * 适配分：仅当所有维度都是“已知”时才有（配置 total.requiresAllDimensionsKnown）。
 * 否则不出分数——资料不足不是 0 分，也不会被忽略后放大剩余得分（ADR-0005）。
 * 纯函数：相同的分析结果、偏好与规则 ⇒ 相同的分数。
 */
export function computeFitScore(dims: DimensionResults, importance: Importance, rules: ScoringRules = scoringRules): FitScore {
  const all = rules.dimensions.map((d) => d.key);
  const known = knownDimensions(dims, rules);
  const notKnown = all.filter((k) => !known.includes(k));
  if (rules.total.requiresAllDimensionsKnown && notKnown.length > 0) return { kind: "unscored", known, notKnown };
  if (known.length === 0) return { kind: "unscored", known, notKnown };
  return {
    kind: "scored",
    score: weightedScore(dims, known, importance, rules),
    importance: Object.fromEntries(all.map((k) => [k, importanceOf(importance, k, rules)])),
  };
}
