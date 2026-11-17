import { describe, expect, it } from "vitest";
import { findOverlaps, type KeyMessage } from "@/domain/chat/overlap";

const m = (speaker: "SELF" | "OTHER", content: string, at?: string): KeyMessage => ({
  speaker,
  content,
  occurredAt: at ? new Date(at) : null,
  timePrecision: at ? "MINUTE" : "UNKNOWN",
});
const pairs = (r: Map<number, number>) => [...r].sort((a, b) => a[0] - b[0]);

describe("消息重叠检测", () => {
  const existing = [m("OTHER", "今晚吃什么"), m("SELF", "火锅怎么样"), m("OTHER", "好呀"), m("SELF", "七点见"), m("OTHER", "不见不散")];

  it("截图重叠：新资料开头与已有结尾的连续序列相同，只匹配重叠部分", () => {
    const incoming = [m("SELF", "七点见"), m("OTHER", "不见不散"), m("SELF", "我到了"), m("OTHER", "马上")];
    expect(pairs(findOverlaps(existing, incoming))).toEqual([[0, 3], [1, 4]]);
  });

  it("整段重复上传：全部匹配", () => {
    expect(pairs(findOverlaps(existing, [...existing]))).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  it("重叠序列出现在已有资料中间（跨批次）也能识别", () => {
    const incoming = [m("OTHER", "好呀"), m("SELF", "七点见"), m("OTHER", "新的一句")];
    expect(pairs(findOverlaps(existing, incoming))).toEqual([[0, 2], [1, 3]]);
  });

  it("保留真实的连续重复发言：单条相同、没有可靠时间的消息不算重叠", () => {
    const prior = [m("OTHER", "哈哈")];
    const incoming = [m("OTHER", "哈哈"), m("OTHER", "哈哈"), m("OTHER", "好玩")];
    expect(findOverlaps(prior, incoming).size).toBe(0);
  });

  it("单条消息只有在双方时间可靠且同一分钟、内容足够长时才算重叠", () => {
    const prior = [m("OTHER", "我已经到楼下了你下来吧", "2026-03-01T12:00:10Z")];
    expect(pairs(findOverlaps(prior, [m("OTHER", "我已经到楼下了你下来吧", "2026-03-01T12:00:50Z")]))).toEqual([[0, 0]]);
    expect(findOverlaps(prior, [m("OTHER", "我已经到楼下了你下来吧", "2026-03-01T12:07:00Z")]).size).toBe(0);
    expect(findOverlaps([m("OTHER", "好的", "2026-03-01T12:00:10Z")], [m("OTHER", "好的", "2026-03-01T12:00:10Z")]).size).toBe(0);
  });

  it("发言人不同、或双方时间都可靠但不同，则不是同一条", () => {
    const a = [m("OTHER", "七点见", "2026-03-01T12:00:00Z"), m("SELF", "好", "2026-03-01T12:01:00Z")];
    expect(findOverlaps(a, [m("SELF", "七点见", "2026-03-01T12:00:00Z"), m("SELF", "好", "2026-03-01T12:01:00Z")]).size).toBe(0);
    expect(findOverlaps(a, [m("OTHER", "七点见", "2026-03-01T13:00:00Z"), m("SELF", "好", "2026-03-01T13:01:00Z")]).size).toBe(0);
  });

  it("忽略首尾空白与多余空格差异", () => {
    const a = [m("OTHER", "七点  见"), m("SELF", "好")];
    expect(findOverlaps(a, [m("OTHER", " 七点 见 "), m("SELF", "好")]).size).toBe(2);
  });

  it("每条已有消息最多被匹配一次：再次出现的同一序列保留", () => {
    const prior = [m("OTHER", "早"), m("SELF", "早呀")];
    const incoming = [m("OTHER", "早"), m("SELF", "早呀"), m("OTHER", "早"), m("SELF", "早呀")];
    expect(pairs(findOverlaps(prior, incoming))).toEqual([[0, 0], [1, 1]]);
  });
});
