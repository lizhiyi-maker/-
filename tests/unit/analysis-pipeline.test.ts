import { describe, expect, it } from "vitest";
import { runAnalysisPipeline, segmentMessages, type SnapshotMessage } from "@/server/analysis/pipeline";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";
import type { MessageRef } from "@/domain/analysis/output";

const DAY = 86_400_000;
const T0 = new Date("2026-03-01T12:00:00Z").getTime();

let n = 0;
function msg(speaker: "SELF" | "OTHER", content: string, over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  n++;
  return {
    id: `msg-${n}`,
    revision: 1,
    batchId: "b1",
    seq: n,
    speaker,
    type: "TEXT",
    content,
    occurredAt: null,
    timePrecision: "UNKNOWN",
    dataKind: "CONTINUOUS",
    ...over,
  };
}
const at = (day: number, minute = 0) => ({ occurredAt: new Date(T0 + day * DAY + minute * 60_000), timePrecision: "MINUTE" as const });

const prefs = { expectation: null, contactFrequency: null, pace: null };
const run = (messages: SnapshotMessage[], model: AnalysisModel = createMockAnalysisModel()) =>
  runAnalysisPipeline({ messages, model, preferences: prefs, userContext: { feelingsNote: null, currentFeeling: null } });

describe("长聊天分段", () => {
  it("按条数与字数切段，每段保持原始顺序，所有消息恰好出现一次", () => {
    const msgs = Array.from({ length: 150 }, (_, i) => msg(i % 2 ? "SELF" : "OTHER", `第${i}句`));
    const segs = segmentMessages(msgs.map((m, i) => ({ ...m, code: `M${i + 1}` })), { maxMessages: 60, maxChars: 10_000 });
    expect(segs.map((s) => s.length)).toEqual([60, 60, 30]);
    expect(segs.flat().map((m) => m.code)).toEqual(msgs.map((_, i) => `M${i + 1}`));
    const byChars = segmentMessages([{ ...msg("SELF", "字".repeat(30)), code: "M1" }, { ...msg("SELF", "字".repeat(30)), code: "M2" }, { ...msg("SELF", "字".repeat(30)), code: "M3" }], { maxMessages: 60, maxChars: 70 });
    expect(byChars.map((s) => s.length)).toEqual([2, 1]);
  });

  it("长聊天分段处理，每条事实仍带指向原始消息的引用，最终报告里的引用都能回查到快照中的真实消息", async () => {
    const msgs: SnapshotMessage[] = [];
    for (let d = 0; d < 40; d++) {
      msgs.push(msg("OTHER", `今天过得怎么样？第${d}天`, at(d)), msg("SELF", "还不错", at(d, 2)));
    }
    const ids = new Set(msgs.map((m) => m.id));
    const r = await run(msgs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.segments).toBeGreaterThan(1);
    const refs = Object.values(r.output.dimensions).flatMap((d) => [...d.observedFacts, ...d.supporting, ...d.counter].flatMap((f) => f.refs)) as MessageRef[];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ids.has(ref.messageId)).toBe(true);
      expect(ref.revision).toBe(1);
    }
  });
});

describe("程序核验，不采信模型自称", () => {
  it("模型说“已知”但证据只有一个单元：降为线索，并丢弃等级建议", async () => {
    // 三条提问紧挨着、同一个批次、没有时间：模拟模型会自称 known，实际只是 1 个证据单元
    const msgs = [msg("OTHER", "你喜欢什么电影？"), msg("OTHER", "周末在干嘛？"), msg("OTHER", "吃饭了吗？")];
    const r = await run(msgs);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const d = r.output.dimensions.willingness_to_know;
    expect(r.meta.verification.willingness_to_know).toMatchObject({ modelStatus: "known", status: "clue", units: 1 });
    expect(d.status).toBe("clue");
    expect(d.level).toBeUndefined();
  });

  it("证据足够（跨多天的多个独立单元）时保留“已知”和等级建议", async () => {
    const msgs = [0, 1, 2].map((d) => msg("OTHER", "最近忙吗？", at(d)));
    const r = await run(msgs);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.output.dimensions.willingness_to_know).toMatchObject({ status: "known", level: "good" });
  });

  it("没有任何证据的维度是“资料不足”，不是低分，也没有等级", async () => {
    const r = await run([msg("OTHER", "早安"), msg("SELF", "早")]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    for (const key of DIMENSION_KEYS) {
      expect(r.output.dimensions[key].status).toBe("insufficient");
      expect(r.output.dimensions[key].level).toBeUndefined();
    }
  });

  it("模型编造了不存在的引用：整次分析失败（不入库），并给出原因", async () => {
    const model: AnalysisModel = {
      ...createMockAnalysisModel(),
      async interpret(input) {
        const out = (await createMockAnalysisModel().interpret(input)) as { dimensions: Record<string, { observedFacts: unknown[] }> };
        out.dimensions.willingness_to_know.observedFacts = [{ text: "编造的事实", refs: ["M9999"] }];
        return out;
      },
    };
    const r = await run([msg("OTHER", "你好吗？")], model);
    expect(r).toMatchObject({ ok: false, code: "INVALID_OUTPUT" });
    if (!r.ok) expect(r.errors.join()).toContain("M9999");
  });

  it("模型在逐段提取事实时引用了别的段的消息：拒绝（保证事实的出处就在本段）", async () => {
    const msgs = Array.from({ length: 70 }, (_, i) => msg("OTHER", `问题${i}？`));
    const model: AnalysisModel = {
      ...createMockAnalysisModel(),
      async extractFacts(input) {
        // 第一段里引用第二段才有的 M70
        if (input.segmentIndex === 0) return { facts: [{ dimension: "willingness_to_know", text: "越界引用", refs: ["M70"], polarity: "support" }] };
        return { facts: [] };
      },
    };
    expect(await run(msgs, model)).toMatchObject({ ok: false, code: "INVALID_FACTS" });
  });

  it("模型抛出异常：作为系统失败返回，不泄露异常内容", async () => {
    const model: AnalysisModel = { ...createMockAnalysisModel(), async extractFacts() { throw new Error("密钥 sk-secret 无效，聊天内容：你好"); } };
    const r = await run([msg("OTHER", "你好吗？")], model);
    expect(r).toMatchObject({ ok: false, code: "MODEL_FAILED", errors: [] });
    // 失败的调用也记用量（类型、耗时、失败），但不带出异常内容
    expect(r.usage).toEqual([expect.objectContaining({ kind: "ANALYSIS_EXTRACT", success: false, inputTokens: null, outputTokens: null })]);
    expect(JSON.stringify(r)).not.toMatch(/sk-secret|你好/);
  });
});

describe("明确拒绝", () => {
  it("对方明确拒绝：标记拒绝，且只保留“尊重边界”类建议，不再有任何推进类建议", async () => {
    const msgs = [msg("SELF", "周六有空吗？想约你吃饭"), msg("OTHER", "不好意思，请不要再联系我了")];
    const r = await run(msgs);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.output.explicitRefusal.detected).toBe(true);
    expect(r.output.suggestions.length).toBeGreaterThan(0);
    expect(r.output.suggestions.every((s) => s.kind === "RESPECT_BOUNDARY")).toBe(true);
  });

  it("即使模型在拒绝之外还给了推进类建议，也会被程序剔除", async () => {
    const model: AnalysisModel = {
      ...createMockAnalysisModel(),
      async interpret(input) {
        const out = (await createMockAnalysisModel().interpret(input)) as { suggestions: unknown[] };
        out.suggestions.push({ kind: "ADVANCE", text: "再约一次", basis: "x", purpose: "y", unknowns: [], refs: [] });
        return out;
      },
    };
    const r = await run([msg("OTHER", "别再联系我")], model);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.output.suggestions.some((s) => s.kind === "ADVANCE" || s.kind === "CLARIFY" || s.kind === "MAINTAIN")).toBe(false);
  });

  it("只有“我”自己说的“不要再联系”不算对方拒绝：声明被程序撤销", async () => {
    const model: AnalysisModel = {
      ...createMockAnalysisModel(),
      async interpret(input) {
        const out = (await createMockAnalysisModel().interpret(input)) as { explicitRefusal: unknown };
        out.explicitRefusal = { detected: true, refs: ["M1"] };
        return out;
      },
    };
    const r = await run([msg("SELF", "我说我不要再联系了"), msg("OTHER", "好的")], model);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.output.explicitRefusal.detected).toBe(false);
  });
});
