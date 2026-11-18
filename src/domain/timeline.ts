import type { EventKind } from "./events";
import type { Feeling } from "@/generated/prisma/enums";

const BEIJING_OFFSET_MS = 8 * 3_600_000;

export interface TimelineEventInput {
  id: string;
  kind: EventKind;
  /** 事件发生的日期（UTC 零点表示的日期） */
  occurredOn: Date;
  facts: string;
  /** 用户的个人感受：与事实分开保存与展示 */
  personalNote: string | null;
  revision: number;
}

export interface TimelineFeelingInput {
  id: string;
  value: Feeling;
  createdAt: Date;
}

export interface TimelineSnapshotInput {
  id: string;
  snapshotAt: Date;
  messageCount: number;
  eventCount: number;
  rulesVersion: string;
  preferenceVersion: number;
  summary: string;
}

export type TimelineItem =
  | { type: "event"; id: string; at: Date; event: TimelineEventInput }
  | { type: "feeling"; id: string; at: Date; value: Feeling; /** 上一次记录的好感；第一条为 null */ from: Feeling | null }
  | {
      type: "analysis";
      id: string;
      at: Date;
      snapshot: TimelineSnapshotInput;
      /** 与上一份分析相比规则版本或偏好版本不同：分差属于口径变化，不能解释为关系升温或降温 */
      baselineChanged: boolean;
    };

const TYPE_ORDER = { event: 0, feeling: 1, analysis: 2 } as const;

/** 事件只有日期：按北京时间当天的起点排序，这样同一天里之后记录的好感、分析排在事件之后。 */
const eventSortKey = (occurredOn: Date) => new Date(occurredOn.getTime() - BEIJING_OFFSET_MS);

/**
 * 把线下事件、好感变化、分析快照合并为一条时间线（最新在前）。纯函数。
 * 好感变化记录“从什么变成什么”；分析快照标注相对上一份分析是否口径变化（规则或偏好版本不同）。
 * “我的好感”与事件里的个人感受只展示，不参与任何评分。
 */
export function buildTimeline(input: { events: TimelineEventInput[]; feelings: TimelineFeelingInput[]; snapshots: TimelineSnapshotInput[] }): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const e of input.events) items.push({ type: "event", id: e.id, at: eventSortKey(e.occurredOn), event: e });

  let prevFeeling: Feeling | null = null;
  for (const f of [...input.feelings].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    items.push({ type: "feeling", id: f.id, at: f.createdAt, value: f.value, from: prevFeeling });
    prevFeeling = f.value;
  }

  let prev: TimelineSnapshotInput | null = null;
  for (const s of [...input.snapshots].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime() || a.id.localeCompare(b.id))) {
    const baselineChanged = prev !== null && (prev.rulesVersion !== s.rulesVersion || prev.preferenceVersion !== s.preferenceVersion);
    items.push({ type: "analysis", id: s.id, at: s.snapshotAt, snapshot: s, baselineChanged });
    prev = s;
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || TYPE_ORDER[b.type] - TYPE_ORDER[a.type] || b.id.localeCompare(a.id));
}
