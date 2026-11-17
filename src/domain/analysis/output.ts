import { z } from "zod";
import { DIMENSION_KEYS, LEVEL_KEYS } from "./rules";

/** 报告里的一条引用：消息 + 修订（见 ADR-0002）。 */
export interface EvidenceRef {
  messageId: string;
  revision: number;
}

export const SUGGESTION_KINDS = ["ADVANCE", "MAINTAIN", "CLARIFY", "RESPECT_BOUNDARY"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** 模型在提示里看到的是短代码（M1、M2…），由程序映射到真实的 消息ID + 修订。 */
const refCode = z.string().regex(/^M\d+$/, "引用必须是形如 M12 的消息代码");
const text = (max: number) => z.string().trim().min(1).max(max);

const evidenceItem = z.object({ text: text(300), refs: z.array(refCode).min(1, "事实和证据必须引用真实消息").max(8) });

const dimensionSchema = z.object({
  status: z.enum(["known", "clue", "insufficient"]),
  level: z.string().optional(),
  observedFacts: z.array(evidenceItem).max(8),
  interpretations: z.array(z.object({ text: text(300) })).max(5),
  supporting: z.array(evidenceItem).max(8),
  counter: z.array(evidenceItem).max(8),
  missing: z.array(text(200)).max(6),
  /** 用户自己的感受/体验，单独存放，不是对方的客观事实 */
  userExperience: z.array(text(300)).max(4).default([]),
});

const suggestionSchema = z.object({
  kind: z.enum(SUGGESTION_KINDS),
  text: text(300),
  basis: text(300),
  purpose: text(200),
  unknowns: z.array(text(200)).max(5),
  refs: z.array(refCode).max(6),
});

export const modelOutputSchema = z.object({
  conclusion: z.object({
    summary: text(600),
    /** AI 只能建议阶段，最终由用户确认 */
    stageSuggestion: z.object({ stage: z.enum(["JUST_MET", "GETTING_TO_KNOW", "IN_RELATIONSHIP", "ENDED"]), reason: text(200) }).optional(),
  }),
  dimensions: z.record(z.string(), dimensionSchema),
  explicitRefusal: z.object({ detected: z.boolean(), refs: z.array(refCode).max(5) }),
  suggestions: z.array(suggestionSchema).max(3, "最多 3 条行动建议"),
});

// ───────── 校验后的结果（引用已解析为真实消息）─────────

type Resolved<T> = T extends { refs: string[] } ? Omit<T, "refs"> & { refs: EvidenceRef[] } : T;

export interface ResolvedDimension {
  status: "known" | "clue" | "insufficient";
  level?: string;
  observedFacts: Resolved<z.infer<typeof evidenceItem>>[];
  interpretations: { text: string }[];
  supporting: Resolved<z.infer<typeof evidenceItem>>[];
  counter: Resolved<z.infer<typeof evidenceItem>>[];
  missing: string[];
  userExperience: string[];
}

export interface ResolvedSuggestion {
  kind: SuggestionKind;
  text: string;
  basis: string;
  purpose: string;
  unknowns: string[];
  refs: EvidenceRef[];
}

export interface AnalysisOutput {
  conclusion: z.infer<typeof modelOutputSchema>["conclusion"];
  dimensions: Record<string, ResolvedDimension>;
  explicitRefusal: { detected: boolean; refs: EvidenceRef[] };
  suggestions: ResolvedSuggestion[];
}

export type RefMap = Map<string, EvidenceRef>;
export type ValidationResult = { ok: true; output: AnalysisOutput } | { ok: false; errors: string[] };

// 不做心理诊断、人格类型判断（docs/business/analysis-spec.md §4）。这是兜底的拒绝词表，不是完整的安全方案。
const DIAGNOSIS = /(焦虑症|抑郁症|躁郁|双相|强迫症|自恋型|人格障碍|依恋类型|回避型|焦虑型依恋|反社会|边缘型|PUA|精神病|心理疾病|病态)/;
// 不展示成功率/概率，也不展示伪装成统计校准的百分比。
const PROBABILITY = /(成功率|成功概率|概率|几率|把握有|\d+(\.\d+)?\s*[%％]|[一二三四五六七八九十]成把握)/;

/** 模型输出里所有会展示给用户的文字。 */
function allTexts(o: z.infer<typeof modelOutputSchema>): string[] {
  const out: string[] = [o.conclusion.summary, o.conclusion.stageSuggestion?.reason ?? ""];
  for (const d of Object.values(o.dimensions)) {
    out.push(...d.observedFacts.map((f) => f.text), ...d.interpretations.map((i) => i.text), ...d.supporting.map((f) => f.text), ...d.counter.map((f) => f.text), ...d.missing, ...d.userExperience);
  }
  for (const s of o.suggestions) out.push(s.text, s.basis, s.purpose, ...s.unknowns);
  return out.filter(Boolean);
}

/**
 * 校验模型的结构化输出：结构（Zod）→ 维度齐全且等级合法 → 每条引用都能解析到本次快照内真实的消息 →
 * 不含诊断与概率。通过后把引用代码替换为 消息ID + 修订号。校验失败不抛出，返回错误列表。
 */
export function validateModelOutput(raw: unknown, refMap: RefMap): ValidationResult {
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "输出"}: ${i.message}`) };
  }
  const o = parsed.data;
  const errors: string[] = [];

  const keys = Object.keys(o.dimensions);
  for (const k of DIMENSION_KEYS) if (!keys.includes(k)) errors.push(`缺少维度 ${k}`);
  for (const k of keys) if (!DIMENSION_KEYS.includes(k)) errors.push(`未知维度 ${k}`);
  for (const [k, d] of Object.entries(o.dimensions)) {
    if (d.level !== undefined && !LEVEL_KEYS.includes(d.level)) errors.push(`维度 ${k} 的等级 ${d.level} 不在配置的档位内`);
  }

  const missingCodes = new Set<string>();
  const collect = (codes: string[]) => codes.forEach((c) => !refMap.has(c) && missingCodes.add(c));
  for (const d of Object.values(o.dimensions)) {
    for (const f of [...d.observedFacts, ...d.supporting, ...d.counter]) collect(f.refs);
  }
  collect(o.explicitRefusal.refs);
  for (const s of o.suggestions) collect(s.refs);
  for (const c of missingCodes) errors.push(`引用 ${c} 不存在于本次分析的资料`);

  if (o.explicitRefusal.detected && o.explicitRefusal.refs.length === 0) errors.push("声明对方明确拒绝时必须给出引用");

  const texts = allTexts(o);
  if (texts.some((t) => DIAGNOSIS.test(t))) errors.push("输出包含心理诊断或人格类型判断");
  if (texts.some((t) => PROBABILITY.test(t))) errors.push("输出包含成功率、概率或百分比");

  if (errors.length > 0) return { ok: false, errors };

  const resolve = (codes: string[]): EvidenceRef[] => codes.map((c) => ({ ...refMap.get(c)! }));
  const item = (f: z.infer<typeof evidenceItem>) => ({ text: f.text, refs: resolve(f.refs) });
  return {
    ok: true,
    output: {
      conclusion: o.conclusion,
      dimensions: Object.fromEntries(
        Object.entries(o.dimensions).map(([k, d]) => [
          k,
          {
            status: d.status,
            level: d.level,
            observedFacts: d.observedFacts.map(item),
            interpretations: d.interpretations,
            supporting: d.supporting.map(item),
            counter: d.counter.map(item),
            missing: d.missing,
            userExperience: d.userExperience,
          },
        ]),
      ),
      explicitRefusal: { detected: o.explicitRefusal.detected, refs: resolve(o.explicitRefusal.refs) },
      suggestions: o.suggestions.map((s) => ({ ...s, refs: resolve(s.refs) })),
    },
  };
}
