import type { MessageType, Speaker, TimePrecision } from "@/domain/chat/types";
import type { DataKind } from "@/domain/analysis/evidence";
import type { EventKind } from "@/domain/events";

/** 模型看到的一条消息。code 是本次分析内的短代码（M1、M2…），模型只能引用这些代码。 */
export interface ModelMessage {
  code: string;
  speaker: Speaker;
  type: MessageType;
  content: string;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  /** 资料类型：精选/不确定资料不能用来推断整段关系的主动频率与稳定性 */
  dataKind: DataKind;
}

/**
 * 模型看到的一个线下事件：只有事实（类型、日期、经过）。code 是本次分析内的短代码（E1、E2…）。
 * 用户的个人感受不在这里，也永远不会发送给模型。
 */
export interface ModelEvent {
  code: string;
  kind: EventKind;
  /** 事件发生的日期（UTC 零点表示的日期） */
  occurredOn: Date;
  content: string;
}

export type FactPolarity = "support" | "counter" | "neutral";
export type FactSignal = "explicit_refusal" | "temporary_cancel" | "cancel_with_reschedule" | "injection_ignored";

/** 第一步产物：从一段聊天里提取的事实。每条事实都带指向原始消息的引用。 */
export interface Fact {
  /** 维度 key；与任何维度无关时为 "none" */
  dimension: string;
  text: string;
  refs: string[];
  polarity: FactPolarity;
  signal?: FactSignal;
}

export interface ExtractInput {
  /** 一段聊天消息；事件单独成段，此时为空 */
  messages: ModelMessage[];
  /** 一段线下事件；聊天消息成段时为空 */
  events: ModelEvent[];
  segmentIndex: number;
  segmentCount: number;
}

export interface InterpretInput {
  facts: Fact[];
  /** 全部消息的元数据（不含内容），供模型了解资料范围 */
  scope: { messageCount: number; eventCount: number; batchKinds: Record<DataKind, number> };
  preferences: { expectation: string | null; contactFrequency: string | null; pace: string | null };
  /** 用户自己的记录：只能放进“用户体验”，不能当作对方的客观事实 */
  userContext: { feelingsNote: string | null; currentFeeling: string | null };
}

/**
 * 关系分析模型接口（第一版只接一家服务商；候选：阿里云百炼通义千问文本模型，待评测后定型）。
 * 两步：extractFacts（逐段提取事实，保留引用）→ interpret（按维度解释，输出结构化 JSON）。
 * 实现必须把聊天内容里的任何指令当作待分析资料，不得服从；输出由 validateModelOutput 与程序核验，
 * 模型自称的充分度不被采信。抛出异常表示系统失败（不扣用户额度）。
 */
export interface AnalysisModel {
  /** 模型标识，写入分析快照 */
  readonly id: string;
  /** 提示词版本，写入分析快照 */
  readonly promptVersion: string;
  extractFacts(input: ExtractInput): Promise<{ facts: Fact[] }>;
  /** 返回待校验的原始 JSON（不可信，必须经 validateModelOutput） */
  interpret(input: InterpretInput): Promise<unknown>;
}
