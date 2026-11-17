import { isReliableTime, type Speaker, type TimePrecision } from "./types";

export interface KeyMessage {
  speaker: Speaker;
  content: string;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
}

const MIN_RUN = 2;
const MIN_SINGLE_LENGTH = 6;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** 在两者中较粗的精度上比较时间；任一方没有时间信息则视为兼容。 */
function timesCompatible(a: KeyMessage, b: KeyMessage): boolean {
  if (!a.occurredAt || !b.occurredAt) return true;
  const known = (p: TimePrecision) => isReliableTime(p) || p === "DATE";
  if (!known(a.timePrecision) || !known(b.timePrecision)) return true;
  if (isReliableTime(a.timePrecision) && isReliableTime(b.timePrecision)) {
    return Math.floor(a.occurredAt.getTime() / 60_000) === Math.floor(b.occurredAt.getTime() / 60_000);
  }
  const day = (d: Date) => Math.floor((d.getTime() + BEIJING_OFFSET_MS) / 86_400_000);
  return day(a.occurredAt) === day(b.occurredAt);
}

function same(a: KeyMessage, b: KeyMessage): boolean {
  return a.speaker === b.speaker && normalize(a.content) === normalize(b.content) && timesCompatible(a, b);
}

/** 单条匹配只有在双方时间可靠、同一分钟且内容足够长时才可信。 */
function strongSingle(a: KeyMessage, b: KeyMessage): boolean {
  return (
    isReliableTime(a.timePrecision) &&
    isReliableTime(b.timePrecision) &&
    normalize(a.content).length >= MIN_SINGLE_LENGTH
  );
}

/**
 * 找出新资料（incoming）中与已有资料（existing）重叠的消息，返回 新资料下标 → 已有资料下标。
 *
 * 按"连续序列"匹配而不是逐条按内容去重：至少 2 条连续相同才算重叠（强单条除外），
 * 因此同一个人真实的连续重复发言（如两次"哈哈"）会被保留。
 * 每条已有消息至多被匹配一次，优先采用更长的序列。
 * 注意：若已有资料里本来就有一段完全相同的连续序列，仍会被判为重叠——这是需要用户确认的情形。
 */
export function findOverlaps(existing: KeyMessage[], incoming: KeyMessage[]): Map<number, number> {
  const runs: { i: number; j: number; len: number }[] = [];
  for (let i = 0; i < incoming.length; i++) {
    for (let j = 0; j < existing.length; j++) {
      if (!same(incoming[i], existing[j])) continue;
      if (i > 0 && j > 0 && same(incoming[i - 1], existing[j - 1])) continue; // 不是序列起点
      let len = 1;
      while (i + len < incoming.length && j + len < existing.length && same(incoming[i + len], existing[j + len])) len++;
      if (len >= MIN_RUN || strongSingle(incoming[i], existing[j])) runs.push({ i, j, len });
    }
  }
  runs.sort((a, b) => b.len - a.len || a.i - b.i || a.j - b.j);

  const result = new Map<number, number>();
  const usedExisting = new Set<number>();
  for (const run of runs) {
    let free = true;
    for (let k = 0; k < run.len; k++) {
      if (result.has(run.i + k) || usedExisting.has(run.j + k)) free = false;
    }
    if (!free) continue;
    for (let k = 0; k < run.len; k++) {
      result.set(run.i + k, run.j + k);
      usedExisting.add(run.j + k);
    }
  }
  return result;
}
