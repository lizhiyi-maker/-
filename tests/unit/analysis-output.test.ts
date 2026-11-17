import { describe, expect, it } from "vitest";
import { validateModelOutput } from "@/domain/analysis/output";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";

const refMap = new Map([
  ["M1", { messageId: "msg-1", revision: 1 }],
  ["M2", { messageId: "msg-2", revision: 3 }],
  ["M3", { messageId: "msg-3", revision: 1 }],
]);

const emptyDim = () => ({ status: "insufficient", observedFacts: [], interpretations: [], supporting: [], counter: [], missing: ["资料中没有相关内容"], userExperience: [] });

/** 一份合法的输出：五个维度齐全，一个有证据的维度 */
function valid(patch: Record<string, unknown> = {}) {
  return {
    conclusion: { summary: "资料较少，目前只能看到少量互动。" },
    dimensions: {
      ...Object.fromEntries(DIMENSION_KEYS.map((k) => [k, emptyDim()])),
      willingness_to_know: {
        status: "clue",
        observedFacts: [{ text: "对方问了你周末的安排", refs: ["M1"] }],
        interpretations: [{ text: "可能想了解你，也可能只是寒暄" }],
        supporting: [{ text: "主动提问", refs: ["M1"] }],
        counter: [],
        missing: ["只有一次提问"],
        userExperience: ["你觉得对方很关心你"],
      },
    },
    explicitRefusal: { detected: false, refs: [] },
    suggestions: [{ kind: "CLARIFY", text: "找机会多聊聊兴趣", basis: "目前只有一次提问", purpose: "补充了解", unknowns: ["对方是否愿意见面"], refs: ["M1"] }],
    ...patch,
  };
}

const errorsOf = (raw: unknown) => {
  const r = validateModelOutput(raw, refMap);
  return r.ok ? [] : r.errors;
};

describe("分析输出校验", () => {
  it("合法的输出通过，引用代码被解析为真实的 消息ID + 修订号", () => {
    const r = validateModelOutput(valid(), refMap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.output.dimensions.willingness_to_know;
    expect(d.observedFacts[0].refs).toEqual([{ messageId: "msg-1", revision: 1 }]);
    expect(r.output.suggestions[0].refs).toEqual([{ messageId: "msg-1", revision: 1 }]);
  });

  it("引用了本次资料里不存在的消息：拒绝（伪造或越界的引用）", () => {
    const bad = valid();
    (bad.dimensions.willingness_to_know.observedFacts[0] as { refs: string[] }).refs = ["M999"];
    expect(errorsOf(bad).join()).toContain("M999");
    const badSuggestion = valid({ suggestions: [{ kind: "CLARIFY", text: "x", basis: "y", purpose: "z", unknowns: [], refs: ["M404"] }] });
    expect(errorsOf(badSuggestion).join()).toContain("M404");
    const badRefusal = valid({ explicitRefusal: { detected: true, refs: ["M77"] } });
    expect(errorsOf(badRefusal).join()).toContain("M77");
  });

  it("观察到的事实、支持/反面证据必须带引用：没有引用的“事实”不能入库（防止把用户感受当成对方的事实）", () => {
    const bad = valid();
    bad.dimensions.willingness_to_know.observedFacts = [{ text: "对方其实很喜欢你", refs: [] }];
    expect(errorsOf(bad).length).toBeGreaterThan(0);
    const bad2 = valid();
    (bad2.dimensions.willingness_to_know as { counter: unknown[] }).counter = [{ text: "对方态度冷淡", refs: [] }];
    expect(errorsOf(bad2).length).toBeGreaterThan(0);
  });

  it("用户感受单独存放（userExperience），不会混进事实或证据", () => {
    const r = validateModelOutput(valid(), refMap);
    expect(r.ok && r.output.dimensions.willingness_to_know.userExperience).toEqual(["你觉得对方很关心你"]);
  });

  it("最多 3 条建议，第 4 条被拒绝", () => {
    const s = { kind: "CLARIFY", text: "a", basis: "b", purpose: "c", unknowns: [], refs: ["M1"] };
    expect(errorsOf(valid({ suggestions: [s, s, s] }))).toEqual([]);
    expect(errorsOf(valid({ suggestions: [s, s, s, s] })).length).toBeGreaterThan(0);
  });

  it("维度必须齐全且不能多出未知维度；等级必须是配置里的档位", () => {
    const missing = valid();
    delete (missing.dimensions as Record<string, unknown>).pace_alignment;
    expect(errorsOf(missing).join()).toContain("pace_alignment");
    const extra = valid();
    (extra.dimensions as Record<string, unknown>).personality_type = emptyDim();
    expect(errorsOf(extra).join()).toContain("personality_type");
    const badLevel = valid();
    (badLevel.dimensions.willingness_to_know as Record<string, unknown>).status = "known";
    (badLevel.dimensions.willingness_to_know as Record<string, unknown>).level = "amazing";
    expect(errorsOf(badLevel).join()).toContain("amazing");
  });

  it("不允许心理诊断或人格类型判断", () => {
    for (const phrase of ["对方有自恋型人格", "疑似焦虑症", "属于回避型依恋", "典型的人格障碍"]) {
      const bad = valid();
      bad.dimensions.willingness_to_know.interpretations = [{ text: phrase }];
      expect(errorsOf(bad).join(), phrase).toContain("诊断");
    }
  });

  it("不允许出现成功率、概率或百分比（信息充分度不是概率）", () => {
    for (const phrase of ["在一起的成功率很高", "成功概率约八成", "把握大概 80%", "可能性 65.5 %"]) {
      const bad = valid({ conclusion: { summary: phrase } });
      expect(errorsOf(bad).join(), phrase).toContain("概率");
    }
  });

  it("结构不合法（不是对象、缺字段、类型错误）被拒绝而不是抛出", () => {
    for (const raw of [null, "text", 42, [], {}, { conclusion: "x" }]) {
      expect(validateModelOutput(raw, refMap).ok).toBe(false);
    }
  });

  it("声明明确拒绝时必须给出引用", () => {
    expect(errorsOf(valid({ explicitRefusal: { detected: true, refs: [] } })).length).toBeGreaterThan(0);
  });
});
