/** 与 Prisma 枚举取值一致；领域层不依赖生成的客户端。 */
export type MessageType = "TEXT" | "IMAGE" | "VOICE" | "SYSTEM" | "OTHER";
export type TimePrecision = "SECOND" | "MINUTE" | "DATE" | "ORDER_ONLY" | "UNKNOWN";
export type Speaker = "SELF" | "OTHER" | "UNKNOWN";

/** 可靠时间：至少精确到分钟。只有可靠时间才能用于计算回复间隔。 */
export const isReliableTime = (p: TimePrecision) => p === "SECOND" || p === "MINUTE";

export interface ParsedMessage {
  /** 原文中的行号（从 1 起），作为原始出处 */
  line: number;
  /** 文本里出现的发言人名称；无法确定时为 null */
  speakerLabel: string | null;
  content: string;
  type: MessageType;
  /** 仅当原文给出完整日期时才有值；绝不猜测 */
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  /** 解析器无法确定的内容，必须交给用户确认 */
  uncertain: boolean;
  reason?: string;
}

export interface ParseResult {
  parserId: string;
  messages: ParsedMessage[];
  labels: { label: string; count: number }[];
}
