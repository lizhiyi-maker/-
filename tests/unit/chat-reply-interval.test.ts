import { describe, expect, it } from "vitest";
import { computeReplyIntervals } from "@/domain/chat/reply-interval";
import type { Speaker, TimePrecision } from "@/domain/chat/types";

const m = (speaker: Speaker, at: string | null, precision: TimePrecision = at ? "SECOND" : "UNKNOWN") => ({
  speaker,
  occurredAt: at ? new Date(at) : null,
  timePrecision: precision,
});

describe("回复间隔", () => {
  it("发言人切换且双方时间都可靠时，计算秒数", () => {
    const r = computeReplyIntervals([
      m("OTHER", "2026-03-01T12:00:00Z"),
      m("SELF", "2026-03-01T12:02:30Z"),
      m("OTHER", "2026-03-01T12:03:00Z"),
    ]);
    expect(r).toEqual([
      { from: 0, to: 1, seconds: 150, replier: "SELF" },
      { from: 1, to: 2, seconds: 30, replier: "OTHER" },
    ]);
  });

  it("同一发言人连续发送不是回复，不计算", () => {
    expect(computeReplyIntervals([m("SELF", "2026-03-01T12:00:00Z"), m("SELF", "2026-03-01T12:00:05Z")])).toEqual([]);
  });

  it("没有可靠时间（未知、仅日期、仅顺序）不计算，也不用相邻消息猜测", () => {
    expect(
      computeReplyIntervals([m("OTHER", null), m("SELF", null), m("OTHER", "2026-03-01T00:00:00Z", "DATE"), m("SELF", "2026-03-01T00:00:00Z", "DATE")]),
    ).toEqual([]);
    expect(computeReplyIntervals([m("OTHER", "2026-03-01T12:00:00Z"), m("SELF", null), m("OTHER", "2026-03-01T12:10:00Z")])).toEqual([]);
  });

  it("时间倒序（顺序与时间矛盾）的相邻对不计算", () => {
    expect(computeReplyIntervals([m("OTHER", "2026-03-01T12:05:00Z"), m("SELF", "2026-03-01T12:00:00Z")])).toEqual([]);
  });

  it("未知发言人不参与", () => {
    expect(computeReplyIntervals([m("UNKNOWN", "2026-03-01T12:00:00Z"), m("SELF", "2026-03-01T12:01:00Z")])).toEqual([]);
  });
});
