import { z } from "zod";
import { assessEvidence, type DataKind, type DimensionStatus, type EvidenceMessage } from "@/domain/analysis/evidence";
import { validateModelOutput, type AnalysisOutput, type EvidenceRef, type RefMap, type ResolvedSuggestion } from "@/domain/analysis/output";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";
import type { MessageType, Speaker, TimePrecision } from "@/domain/chat/types";
import type { AnalysisModel, Fact, InterpretInput, ModelMessage } from "@/server/ai/analysis-model";

/** 分析快照里的一条消息：内容取自快照记录的修订，因此即使之后被编辑也能重建当时的输入。 */
export interface SnapshotMessage {
  id: string;
  revision: number;
  batchId: string;
  seq: number;
  speaker: Speaker;
  type: MessageType;
  content: string;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  dataKind: DataKind;
}

export interface PipelineInput {
  messages: SnapshotMessage[];
  model: AnalysisModel;
  preferences: InterpretInput["preferences"];
  userContext: InterpretInput["userContext"];
}

export interface DimensionVerification {
  modelStatus: DimensionStatus;
  status: DimensionStatus;
  units: number;
  contexts: number;
  cappedBy?: "CURATED_OR_UNCERTAIN";
}

export type PipelineResult =
  | {
      ok: true;
      output: AnalysisOutput;
      meta: { segments: number; verification: Record<string, DimensionVerification>; warnings: string[] };
    }
  | { ok: false; code: "MODEL_FAILED" | "INVALID_FACTS" | "INVALID_OUTPUT"; errors: string[] };

/** 单段上限：条数与字数先到者为准。 */
export const SEGMENT_LIMITS = { maxMessages: 60, maxChars: 3500 };

/** 按顺序把消息切成段；每条消息恰好属于一段，保持原始顺序。 */
export function segmentMessages<T extends { content: string }>(messages: T[], limits = SEGMENT_LIMITS): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const m of messages) {
    if (current.length > 0 && (current.length >= limits.maxMessages || chars + m.content.length > limits.maxChars)) {
      segments.push(current);
      current = [];
      chars = 0;
    }
    current.push(m);
    chars += m.content.length;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

const factSchema = z.object({
  dimension: z.string(),
  text: z.string().trim().min(1).max(400),
  refs: z.array(z.string().regex(/^M\d+$/)).min(1).max(8),
  polarity: z.enum(["support", "counter", "neutral"]),
  signal: z.enum(["explicit_refusal", "temporary_cancel", "cancel_with_reschedule", "injection_ignored"]).optional(),
});
const factsSchema = z.object({ facts: z.array(factSchema).max(400) });

const DEFAULT_RESPECT: Omit<ResolvedSuggestion, "refs"> = {
  kind: "RESPECT_BOUNDARY",
  text: "尊重对方的意愿，不再主动联系；如果心里不好受，可以和信任的朋友聊聊。",
  basis: "对方明确表示不希望继续联系",
  purpose: "尊重边界，避免造成困扰",
  unknowns: [],
};

/**
 * 分析流水线：分段提取事实（保留引用）→ 按维度解释 → 结构与引用校验 → 程序核验。
 * 与数据库无关，便于离线评测。程序核验包括：证据充分度重新计算（不采信模型自称）、
 * 明确拒绝必须来自对方的消息，拒绝成立时剔除一切推进类建议。
 */
export async function runAnalysisPipeline(input: PipelineInput): Promise<PipelineResult> {
  const coded: (ModelMessage & { snapshot: SnapshotMessage })[] = input.messages.map((m, i) => ({
    code: `M${i + 1}`,
    speaker: m.speaker,
    type: m.type,
    content: m.content,
    occurredAt: m.occurredAt,
    timePrecision: m.timePrecision,
    dataKind: m.dataKind,
    snapshot: m,
  }));
  const refMap: RefMap = new Map(coded.map((c) => [c.code, { messageId: c.snapshot.id, revision: c.snapshot.revision }]));
  const byCode = new Map(coded.map((c) => [c.code, c.snapshot]));
  const forModel = (c: (typeof coded)[number]): ModelMessage => ({
    code: c.code,
    speaker: c.speaker,
    type: c.type,
    content: c.content,
    occurredAt: c.occurredAt,
    timePrecision: c.timePrecision,
    dataKind: c.dataKind,
  });

  // 1. 分段提取事实
  const segments = segmentMessages(coded);
  const facts: Fact[] = [];
  try {
    for (const [segmentIndex, segment] of segments.entries()) {
      const raw = await input.model.extractFacts({ messages: segment.map(forModel), segmentIndex, segmentCount: segments.length });
      const parsed = factsSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, code: "INVALID_FACTS", errors: parsed.error.issues.slice(0, 5).map((i) => i.message) };
      const inSegment = new Set(segment.map((m) => m.code));
      for (const f of parsed.data.facts) {
        if (f.dimension !== "none" && !DIMENSION_KEYS.includes(f.dimension)) return { ok: false, code: "INVALID_FACTS", errors: [`未知维度 ${f.dimension}`] };
        const outside = f.refs.filter((r) => !inSegment.has(r));
        if (outside.length > 0) return { ok: false, code: "INVALID_FACTS", errors: [`事实引用了本段之外的消息：${outside.join("、")}`] };
        facts.push(f);
      }
    }
  } catch {
    return { ok: false, code: "MODEL_FAILED", errors: [] }; // 不带出异常内容（可能含密钥或聊天文字）
  }

  // 2. 按维度解释
  const batchKinds: Record<DataKind, number> = { CONTINUOUS: 0, CURATED: 0, UNCERTAIN: 0 };
  const kindByBatch = new Map(input.messages.map((m) => [m.batchId, m.dataKind]));
  for (const kind of kindByBatch.values()) batchKinds[kind]++;
  let raw: unknown;
  try {
    raw = await input.model.interpret({
      facts,
      scope: { messageCount: input.messages.length, batchKinds },
      preferences: input.preferences,
      userContext: input.userContext,
    });
  } catch {
    return { ok: false, code: "MODEL_FAILED", errors: [] };
  }

  // 3. 结构与引用校验
  const validated = validateModelOutput(raw, refMap);
  if (!validated.ok) return { ok: false, code: "INVALID_OUTPUT", errors: validated.errors };
  const output = validated.output;

  // 4. 程序核验
  const warnings: string[] = [];
  const verification: Record<string, DimensionVerification> = {};
  const evidenceOf = (refs: EvidenceRef[]): EvidenceMessage[] =>
    refs.flatMap((r) => {
      const m = input.messages.find((x) => x.id === r.messageId);
      return m ? [{ id: m.id, batchId: m.batchId, seq: m.seq, occurredAt: m.occurredAt, timePrecision: m.timePrecision, dataKind: m.dataKind }] : [];
    });

  for (const key of DIMENSION_KEYS) {
    const d = output.dimensions[key];
    const cited = [...d.observedFacts, ...d.supporting, ...d.counter].flatMap((f) => f.refs);
    const assessed = assessEvidence(key, evidenceOf(cited));
    const modelStatus = d.status;
    let status = assessed.status;
    if (status === "known" && !d.level) {
      status = "clue"; // 没有等级建议就不能计分
      warnings.push(`${key}：模型未给出等级建议，已降为线索`);
    }
    if (modelStatus !== status) warnings.push(`${key}：模型自称“${modelStatus}”，程序核验为“${status}”`);
    d.status = status;
    if (status !== "known") delete d.level; // 非“已知”的维度，等级建议被丢弃
    verification[key] = { modelStatus, status, units: assessed.units, contexts: assessed.contexts, cappedBy: assessed.cappedBy };
  }

  // 明确拒绝：必须有来自“对方”的消息作依据；事实里带拒绝信号且来自对方的，同样视为成立（宁可保守）
  const isOther = (code: string) => byCode.get(code)?.speaker === "OTHER";
  const factRefusalRefs = facts.filter((f) => f.signal === "explicit_refusal").flatMap((f) => f.refs).filter(isOther);
  const claimedByOther = output.explicitRefusal.refs.some((r) => input.messages.find((m) => m.id === r.messageId)?.speaker === "OTHER");
  if (output.explicitRefusal.detected && !claimedByOther) {
    warnings.push("模型声明对方明确拒绝，但引用里没有对方的消息，已撤销该声明");
    output.explicitRefusal = { detected: false, refs: [] };
  }
  if (!output.explicitRefusal.detected && factRefusalRefs.length > 0) {
    output.explicitRefusal = { detected: true, refs: [...new Set(factRefusalRefs)].slice(0, 5).map((c) => ({ ...refMap.get(c)! })) };
  }
  if (output.explicitRefusal.detected) {
    output.suggestions = output.suggestions.filter((s) => s.kind === "RESPECT_BOUNDARY");
    if (output.suggestions.length === 0) output.suggestions = [{ ...DEFAULT_RESPECT, refs: output.explicitRefusal.refs.slice(0, 3) }];
  }

  return { ok: true, output, meta: { segments: segments.length, verification, warnings } };
}
