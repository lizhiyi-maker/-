import { isReliableTime, type TimePrecision } from "@/domain/chat/types";
import { scoringRules } from "./rules";

export type DimensionStatus = "known" | "clue" | "insufficient";
export type DataKind = "CONTINUOUS" | "CURATED" | "UNCERTAIN";

export interface EvidenceMessage {
  id: string;
  batchId: string;
  /** 批次内顺序 */
  seq: number;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  dataKind: DataKind;
}

export interface EvidenceAssessment {
  status: DimensionStatus;
  /** 独立证据单元数 */
  units: number;
  /** 不同情境数（日期，或时间未知时按来源批次区分） */
  contexts: number;
  /** 因精选/不确定资料被封顶时标注 */
  cappedBy?: "CURATED_OR_UNCERTAIN";
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;
/** 无可靠时间的消息，相隔不超过这个条数视为同一话题窗口 */
const SEQ_WINDOW = 2;

const dayKey = (d: Date) => new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

/** 时间未知的消息不能证明跨日期，只能按来源批次区分情境。 */
function contextOf(m: EvidenceMessage): string {
  if (m.occurredAt && (isReliableTime(m.timePrecision) || m.timePrecision === "DATE")) return `d:${dayKey(m.occurredAt)}`;
  return `b:${m.batchId}`;
}

/**
 * 把证据消息合并为“证据单元”：同一批次内，时间可靠的消息相邻间隔不超过窗口（默认 30 分钟）即同一单元；
 * 没有可靠时间的消息按顺序号相邻（≤2 条）合并。仅日期精度的时间不用于合并。
 */
function buildUnits(messages: EvidenceMessage[]): EvidenceMessage[][] {
  const windowMs = scoringRules.evidence.unitWindowMinutes * 60_000;
  const units: EvidenceMessage[][] = [];

  const byBatch = new Map<string, EvidenceMessage[]>();
  for (const m of messages) byBatch.set(m.batchId, [...(byBatch.get(m.batchId) ?? []), m]);

  for (const group of byBatch.values()) {
    const timed = group.filter((m) => m.occurredAt && isReliableTime(m.timePrecision)).sort((a, b) => a.occurredAt!.getTime() - b.occurredAt!.getTime());
    let current: EvidenceMessage[] = [];
    for (const m of timed) {
      const last = current[current.length - 1];
      if (last && m.occurredAt!.getTime() - last.occurredAt!.getTime() <= windowMs) current.push(m);
      else {
        if (current.length) units.push(current);
        current = [m];
      }
    }
    if (current.length) units.push(current);

    const untimed = group.filter((m) => !(m.occurredAt && isReliableTime(m.timePrecision))).sort((a, b) => a.seq - b.seq);
    current = [];
    for (const m of untimed) {
      const last = current[current.length - 1];
      // 仅日期精度的消息不能跨日期合并（否则会丢掉一个情境）
      if (last && m.seq - last.seq <= SEQ_WINDOW && contextOf(m) === contextOf(last)) current.push(m);
      else {
        if (current.length) units.push(current);
        current = [m];
      }
    }
    if (current.length) units.push(current);
  }
  return units;
}

function statusOf(units: EvidenceMessage[][]): { status: DimensionStatus; units: number; contexts: number } {
  const { sufficient, clue } = scoringRules.evidence;
  const contexts = new Set(units.map((u) => contextOf(u[0]))).size;
  let status: DimensionStatus = "insufficient";
  if (units.length >= sufficient.minUnits && contexts >= sufficient.minDistinctContexts) status = "known";
  else if (units.length >= clue.minUnits) status = "clue";
  return { status, units: units.length, contexts };
}

/**
 * 程序核验一个维度的证据充分度（不采信模型自称的状态）。输入是该维度引用的全部消息。
 * 规则（阈值来自 config/scoring/v0.json）：≥3 单元且 ≥2 情境为“已知”；1–2 单元为“线索”；0 为“资料不足”。
 * 配置中列出的维度（双向投入）只统计连续聊天的证据；仅靠精选/不确定资料最多到“线索”。
 */
export function assessEvidence(dimension: string, input: EvidenceMessage[]): EvidenceAssessment {
  const unique = [...new Map(input.map((m) => [m.id, m])).values()];
  const all = statusOf(buildUnits(unique));
  if (!scoringRules.evidence.curatedOrUncertainCapAtClue.includes(dimension)) return all;

  const continuous = statusOf(buildUnits(unique.filter((m) => m.dataKind === "CONTINUOUS")));
  if (continuous.status === "known") return continuous;
  if (all.status === "known") return { ...all, status: "clue", cappedBy: "CURATED_OR_UNCERTAIN" };
  return all;
}
