import { isReliableTime, type Speaker, type TimePrecision } from "./types";

export interface TimedMessage {
  speaker: Speaker;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
}

export interface ReplyInterval {
  from: number;
  to: number;
  seconds: number;
  replier: "SELF" | "OTHER";
}

/**
 * 回复间隔：只在"相邻、发言人切换、双方时间都可靠（至少到分钟）、且时间不倒序"时计算。
 * 没有可靠时间的消息一律跳过，不用邻近消息推断，也不使用日期精度的时间。
 */
export function computeReplyIntervals(messages: TimedMessage[]): ReplyInterval[] {
  const out: ReplyInterval[] = [];
  for (let to = 1; to < messages.length; to++) {
    const a = messages[to - 1];
    const b = messages[to];
    if (a.speaker === "UNKNOWN" || b.speaker === "UNKNOWN" || a.speaker === b.speaker) continue;
    if (!a.occurredAt || !b.occurredAt || !isReliableTime(a.timePrecision) || !isReliableTime(b.timePrecision)) continue;
    const ms = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (ms < 0) continue;
    out.push({ from: to - 1, to, seconds: ms / 1000, replier: b.speaker });
  }
  return out;
}
