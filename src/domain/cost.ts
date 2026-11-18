import { z } from "zod";
import raw from "../../config/cost.json";

const price = z.object({ inputPerMillionTokens: z.number().nonnegative().nullable(), outputPerMillionTokens: z.number().nonnegative().nullable() });
const schema = z.object({ currency: z.literal("CNY"), pricesVerified: z.boolean(), notice: z.string(), default: price, models: z.record(z.string(), price) });
export type CostPricing = z.infer<typeof schema>;

/** 成本估算的单价配置（唯一来源：config/cost.json）。单价未核实时界面须如实标注。 */
export const costPricing: CostPricing = schema.parse(raw);

export const USAGE_KIND_LABEL = { ANALYSIS_EXTRACT: "分析·提取事实", ANALYSIS_INTERPRET: "分析·按维度解释", RECOGNITION: "截图识别" } as const;
export type UsageKindKey = keyof typeof USAGE_KIND_LABEL;

export interface UsageSample {
  kind: UsageKindKey;
  taskId: string;
  modelId: string;
  simulated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  success: boolean;
  /** 百万分之一元；null = 无法估算 */
  costMicroYuan: number | null;
  createdAt: Date;
}

/**
 * 估算一次调用的成本（单位：百万分之一元）。纯函数。
 * 模拟模型没有真实成本，记 0；真实模型需要输入、输出的用量与对应单价都已知才能估算，否则返回 null（“无法估算”，不猜）。
 * 元 = token ÷ 10⁶ × 每百万 token 单价，因此 百万分之一元 = token × 每百万 token 单价。
 */
export function estimateCostMicroYuan(u: Pick<UsageSample, "modelId" | "simulated" | "inputTokens" | "outputTokens">, pricing: CostPricing = costPricing): number | null {
  if (u.simulated) return 0;
  const p = pricing.models[u.modelId] ?? pricing.default;
  if (u.inputTokens === null || u.outputTokens === null || p.inputPerMillionTokens === null || p.outputPerMillionTokens === null) return null;
  return Math.round(u.inputTokens * p.inputPerMillionTokens + u.outputTokens * p.outputPerMillionTokens);
}

export interface UsageTotals {
  calls: number;
  failures: number;
  simulatedCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** 已知成本之和（百万分之一元） */
  costMicroYuan: number;
  /** 无法估算成本的调用数（这些调用不在 costMicroYuan 里） */
  unknownCostCalls: number;
}

const emptyTotals = (): UsageTotals => ({ calls: 0, failures: 0, simulatedCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, costMicroYuan: 0, unknownCostCalls: 0 });
function add(t: UsageTotals, u: UsageSample) {
  t.calls++;
  if (!u.success) t.failures++;
  if (u.simulated) t.simulatedCalls++;
  t.inputTokens += u.inputTokens ?? 0;
  t.outputTokens += u.outputTokens ?? 0;
  t.durationMs += u.durationMs;
  if (u.costMicroYuan === null) t.unknownCostCalls++;
  else t.costMicroYuan += u.costMicroYuan;
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const dayOf = (d: Date) => new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

export interface UsageSummary {
  total: UsageTotals;
  /** 按北京时间日期，从新到旧 */
  byDay: ({ day: string } & UsageTotals)[];
  byKind: ({ kind: UsageKindKey } & UsageTotals)[];
  byModel: ({ modelId: string; simulated: boolean } & UsageTotals)[];
  /**
   * 每次分析的平均成本：只统计所有调用成本都已知的分析（含失败的调用，因为花掉了）；
   * 一份都没有时 average 为 null（无法估算，不是 0）。
   */
  perAnalysis: { analyses: number; withKnownCost: number; averageMicroYuan: number | null };
  /** 全部调用都来自模拟模型：没有真实成本 */
  allSimulated: boolean;
}

/** 汇总用量（纯函数）：总计、按天、按类型、按模型，以及每次分析的平均成本。 */
export function summarizeUsage(rows: UsageSample[]): UsageSummary {
  const total = emptyTotals();
  const days = new Map<string, UsageTotals>();
  const kinds = new Map<UsageKindKey, UsageTotals>();
  const models = new Map<string, { simulated: boolean; t: UsageTotals }>();
  const analyses = new Map<string, UsageSample[]>();
  const bucket = <K>(m: Map<K, UsageTotals>, k: K) => m.get(k) ?? m.set(k, emptyTotals()).get(k)!;

  for (const u of rows) {
    add(total, u);
    add(bucket(days, dayOf(u.createdAt)), u);
    add(bucket(kinds, u.kind), u);
    const mk = `${u.modelId}\u0000${u.simulated}`;
    if (!models.has(mk)) models.set(mk, { simulated: u.simulated, t: emptyTotals() });
    add(models.get(mk)!.t, u);
    if (u.kind !== "RECOGNITION") analyses.set(u.taskId, [...(analyses.get(u.taskId) ?? []), u]);
  }

  const known = [...analyses.values()].filter((calls) => calls.every((c) => c.costMicroYuan !== null));
  const knownSum = known.reduce((s, calls) => s + calls.reduce((x, c) => x + c.costMicroYuan!, 0), 0);
  return {
    total,
    byDay: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, t]) => ({ day, ...t })),
    byKind: [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, t]) => ({ kind, ...t })),
    byModel: [...models.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ modelId: k.split("\u0000")[0], simulated: v.simulated, ...v.t })),
    perAnalysis: { analyses: analyses.size, withKnownCost: known.length, averageMicroYuan: known.length > 0 ? Math.round(knownSum / known.length) : null },
    allSimulated: rows.length > 0 && rows.every((r) => r.simulated),
  };
}

/** 百万分之一元 → “¥0.0123” */
export const formatYuan = (micro: number) => `¥${(micro / 1_000_000).toFixed(4)}`;
