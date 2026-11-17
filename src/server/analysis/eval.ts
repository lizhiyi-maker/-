import { parseChatText } from "@/domain/chat/parser";
import type { DataKind } from "@/domain/analysis/evidence";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";
import type { AnalysisOutput } from "@/domain/analysis/output";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { runAnalysisPipeline, type PipelineResult, type SnapshotMessage } from "./pipeline";

export interface EvalExpect {
  /** 维度 → 允许的状态 */
  statuses?: Record<string, string[]>;
  refusal?: boolean;
  /** 建议类型只能是这些 */
  suggestionKindsOnly?: string[];
  counterCount?: Record<string, number>;
  /** 这些维度不得有等级建议 */
  levelAbsent?: string[];
  textContains?: string[];
  textExcludes?: string[];
  /** 各维度的状态与等级必须与另一个用例相同 */
  sameDimensionsAs?: string;
}

export interface EvalCase {
  id: string;
  title: string;
  self: string;
  chats: { dataKind: DataKind; text: string }[];
  expect: EvalExpect;
}

export interface EvalCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

export interface EvalResult {
  id: string;
  title: string;
  passed: boolean;
  checks: EvalCheck[];
  statuses: Record<string, string>;
}

/** 把评测用例里的聊天文本转成分析快照（“我”按 self 标签判定，其余为对方）。 */
export function caseMessages(c: EvalCase): SnapshotMessage[] {
  const out: SnapshotMessage[] = [];
  c.chats.forEach((chat, b) => {
    parseChatText(chat.text).messages.forEach((m, i) => {
      out.push({
        id: `${c.id}-${b}-${i}`,
        revision: 1,
        batchId: `${c.id}-b${b}`,
        seq: i,
        speaker: m.speakerLabel === c.self ? "SELF" : m.speakerLabel ? "OTHER" : "UNKNOWN",
        type: m.type,
        content: m.content,
        occurredAt: m.occurredAt,
        timePrecision: m.timePrecision,
        dataKind: chat.dataKind,
      });
    });
  });
  return out;
}

function everyText(o: AnalysisOutput): string {
  const parts: string[] = [o.conclusion.summary];
  for (const d of Object.values(o.dimensions)) {
    parts.push(...d.observedFacts.map((f) => f.text), ...d.interpretations.map((i) => i.text), ...d.supporting.map((f) => f.text), ...d.counter.map((f) => f.text), ...d.missing, ...d.userExperience);
  }
  for (const s of o.suggestions) parts.push(s.text, s.basis, s.purpose, ...s.unknowns);
  return parts.join("\n");
}

const dims = (o: AnalysisOutput) => Object.fromEntries(DIMENSION_KEYS.map((k) => [k, `${o.dimensions[k].status}/${o.dimensions[k].level ?? "-"}`]));

/** 用给定模型跑完整个评测集；每个用例都走真实的校验器与程序核验。 */
export async function runEvalCases(cases: EvalCase[], model: AnalysisModel): Promise<EvalResult[]> {
  const prefs = { expectation: null, contactFrequency: null, pace: null };
  const ctx = { feelingsNote: null, currentFeeling: null };
  const runs = new Map<string, PipelineResult>();
  for (const c of cases) runs.set(c.id, await runAnalysisPipeline({ messages: caseMessages(c), model, preferences: prefs, userContext: ctx }));

  return cases.map((c) => {
    const run = runs.get(c.id)!;
    const checks: EvalCheck[] = [];
    const push = (label: string, pass: boolean, detail?: string) => checks.push({ label, pass, detail });
    if (!run.ok) {
      push("流水线完成并通过校验", false, `${run.code}: ${run.errors.join("；")}`);
      return { id: c.id, title: c.title, passed: false, checks, statuses: {} };
    }
    const o = run.output;
    push("流水线完成并通过校验", true);
    const e = c.expect;

    for (const [dim, allowed] of Object.entries(e.statuses ?? {})) {
      const got = o.dimensions[dim].status;
      push(`${dim} 状态 ∈ {${allowed.join(",")}}`, allowed.includes(got), `实际 ${got}`);
    }
    if (e.refusal !== undefined) push(`明确拒绝 = ${e.refusal}`, o.explicitRefusal.detected === e.refusal, `实际 ${o.explicitRefusal.detected}`);
    if (e.suggestionKindsOnly) {
      const kinds = [...new Set(o.suggestions.map((s) => s.kind))];
      push(`建议类型只含 ${e.suggestionKindsOnly.join(",")}`, kinds.length > 0 && kinds.every((k) => e.suggestionKindsOnly!.includes(k)), `实际 ${kinds.join(",") || "无"}`);
    }
    for (const [dim, n] of Object.entries(e.counterCount ?? {})) push(`${dim} 反面证据数 = ${n}`, o.dimensions[dim].counter.length === n, `实际 ${o.dimensions[dim].counter.length}`);
    for (const dim of e.levelAbsent ?? []) push(`${dim} 没有等级建议`, o.dimensions[dim].level === undefined, `实际 ${o.dimensions[dim].level ?? "无"}`);
    const text = everyText(o);
    for (const t of e.textContains ?? []) push(`报告包含“${t}”`, text.includes(t));
    for (const t of e.textExcludes ?? []) push(`报告不含“${t}”`, !text.includes(t));
    if (e.sameDimensionsAs) {
      const base = runs.get(e.sameDimensionsAs);
      const same = base?.ok === true && JSON.stringify(dims(base.output)) === JSON.stringify(dims(o));
      push(`各维度状态与等级和 ${e.sameDimensionsAs} 一致`, same, same ? undefined : `实际 ${JSON.stringify(dims(o))}`);
    }
    return { id: c.id, title: c.title, passed: checks.every((k) => k.pass), checks, statuses: dims(o) };
  });
}

export function renderEvalReport(results: EvalResult[], model: { id: string; promptVersion: string }, generatedAt: string): string {
  const lines: string[] = [
    "# 分析流水线安全评测（模拟模型）",
    "",
    `- 生成时间：${generatedAt}`,
    `- 模型：\`${model.id}\`（规则型模拟模型），提示词版本：\`${model.promptVersion}\``,
    `- 结果：${results.filter((r) => r.passed).length} / ${results.length} 个用例通过`,
    "",
    "> **适用范围**：这些用例经过真实的输出校验器与程序核验，但“模型”是关键词规则写的模拟实现。",
    "> 它验证的是评测框架、校验器、程序核验、拒绝与注入处理，**不代表任何真实模型的质量**。",
    "> 真实模型（候选：阿里云百炼通义千问文本模型）的评测尚未进行，见 docs/verification-matrix.md。",
    "> 用例来源：`samples/eval/analysis-cases.json`（虚构聊天）；对应 docs/scoring/rules-v0-experimental.md §8。",
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.passed ? "✅" : "❌"} ${r.id} — ${r.title}`, "");
    for (const c of r.checks) lines.push(`- ${c.pass ? "✅" : "❌"} ${c.label}${c.detail && !c.pass ? `（${c.detail}）` : ""}`);
    if (Object.keys(r.statuses).length > 0) lines.push("", "各维度（状态/等级）：" + Object.entries(r.statuses).map(([k, v]) => `${k}=${v}`).join("，"));
    lines.push("");
  }
  return lines.join("\n");
}
