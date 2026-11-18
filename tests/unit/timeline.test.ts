import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineEventInput, type TimelineFeelingInput, type TimelineSnapshotInput } from "@/domain/timeline";

const d = (s: string) => new Date(s);
const event = (id: string, on: string, over: Partial<TimelineEventInput> = {}): TimelineEventInput => ({
  id,
  kind: "MEET",
  occurredOn: d(`${on}T00:00:00Z`),
  facts: "事实",
  personalNote: null,
  revision: 1,
  ...over,
});
const feeling = (id: string, at: string, value: TimelineFeelingInput["value"]): TimelineFeelingInput => ({ id, value, createdAt: d(at) });
const snap = (id: string, at: string, over: Partial<TimelineSnapshotInput> = {}): TimelineSnapshotInput => ({
  id,
  snapshotAt: d(at),
  messageCount: 10,
  eventCount: 0,
  rulesVersion: "v0",
  preferenceVersion: 0,
  summary: "结论",
  ...over,
});

describe("时间线", () => {
  it("没有任何记录时为空", () => {
    expect(buildTimeline({ events: [], feelings: [], snapshots: [] })).toEqual([]);
  });

  it("线下事件、好感变化、分析快照合并在一条时间线上，最新在前", () => {
    const items = buildTimeline({
      events: [event("e1", "2026-03-01"), event("e2", "2026-03-20")],
      feelings: [feeling("f1", "2026-03-05T10:00:00Z", "UNSURE"), feeling("f2", "2026-04-01T10:00:00Z", "STRONG")],
      snapshots: [snap("a1", "2026-03-25T10:00:00Z")],
    });
    expect(items.map((i) => `${i.type}:${i.id}`)).toEqual(["feeling:f2", "analysis:a1", "event:e2", "feeling:f1", "event:e1"]);
  });

  it("好感变化记录“从什么变成什么”，第一条没有来源；与记录先后无关，按时间计算", () => {
    const items = buildTimeline({
      events: [],
      feelings: [feeling("f3", "2026-03-09T00:00:00Z", "PAUSE"), feeling("f1", "2026-03-01T00:00:00Z", "UNSURE"), feeling("f2", "2026-03-05T00:00:00Z", "STRONG")],
      snapshots: [],
    });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.f1).toMatchObject({ from: null, value: "UNSURE" });
    expect(byId.f2).toMatchObject({ from: "UNSURE", value: "STRONG" });
    expect(byId.f3).toMatchObject({ from: "STRONG", value: "PAUSE" });
  });

  it("事件只有日期：同一天（北京时间）里之后记录的好感与分析排在事件之前（更新）", () => {
    // 事件日 2026-03-10（北京时间）；当天北京时间 09:00 = UTC 01:00
    const items = buildTimeline({
      events: [event("e1", "2026-03-10")],
      feelings: [feeling("f1", "2026-03-10T01:00:00Z", "STRONG")],
      snapshots: [snap("a1", "2026-03-10T02:00:00Z")],
    });
    expect(items.map((i) => i.id)).toEqual(["a1", "f1", "e1"]);
  });

  it("事件里的事实与个人感受原样分开携带，时间线不合并它们", () => {
    const [item] = buildTimeline({ events: [event("e1", "2026-03-10", { facts: "她迟到了二十分钟", personalNote: "有点失落" })], feelings: [], snapshots: [] });
    expect(item.type === "event" && item.event).toMatchObject({ facts: "她迟到了二十分钟", personalNote: "有点失落" });
  });

  it("相对上一份分析，规则版本或偏好版本不同就标注口径变化；第一份没有可比较的对象", () => {
    const items = buildTimeline({
      events: [],
      feelings: [],
      snapshots: [
        snap("a1", "2026-03-01T00:00:00Z"),
        snap("a2", "2026-03-10T00:00:00Z"), // 与 a1 相同
        snap("a3", "2026-03-20T00:00:00Z", { preferenceVersion: 1 }), // 偏好变了
        snap("a4", "2026-03-30T00:00:00Z", { preferenceVersion: 1, rulesVersion: "v1" }), // 规则变了
        snap("a5", "2026-04-05T00:00:00Z", { preferenceVersion: 1, rulesVersion: "v1", messageCount: 99, eventCount: 3 }), // 只有资料变多
      ],
    });
    const flags = Object.fromEntries(items.map((i) => [i.id, i.type === "analysis" && i.baselineChanged]));
    expect(flags).toEqual({ a1: false, a2: false, a3: true, a4: true, a5: false });
  });

  it("时间完全相同的条目顺序稳定（不依赖输入顺序）", () => {
    const input = { events: [], feelings: [feeling("f1", "2026-03-01T00:00:00Z", "UNSURE")], snapshots: [snap("a1", "2026-03-01T00:00:00Z")] };
    const a = buildTimeline(input).map((i) => i.id);
    const b = buildTimeline({ ...input, snapshots: [...input.snapshots].reverse(), feelings: [...input.feelings].reverse() }).map((i) => i.id);
    expect(a).toEqual(b);
  });
});
