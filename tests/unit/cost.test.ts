import { describe, expect, it } from "vitest";
import { estimateCostMicroYuan, formatYuan, summarizeUsage, type CostPricing, type UsageSample } from "@/domain/cost";

const pricing: CostPricing = {
  currency: "CNY",
  pricesVerified: true,
  notice: "",
  default: { inputPerMillionTokens: 2, outputPerMillionTokens: 6 },
  models: { "special-model": { inputPerMillionTokens: 10, outputPerMillionTokens: 30 }, "unpriced-model": { inputPerMillionTokens: null, outputPerMillionTokens: null } },
};

describe("成本估算", () => {
  const call = { modelId: "m", simulated: false, inputTokens: 1000, outputTokens: 500 };

  it("成本 = token × 每百万 token 单价（单位：百万分之一元）：1000×2 + 500×6 = 5000 → ¥0.0050", () => {
    expect(estimateCostMicroYuan(call, pricing)).toBe(5000);
    expect(formatYuan(5000)).toBe("¥0.0050");
  });

  it("按模型取单价，没有单独配置的用默认单价", () => {
    expect(estimateCostMicroYuan({ ...call, modelId: "special-model" }, pricing)).toBe(1000 * 10 + 500 * 30);
  });

  it("模拟模型没有真实成本，记 0（不是“无法估算”）", () => {
    expect(estimateCostMicroYuan({ ...call, simulated: true, inputTokens: null, outputTokens: null }, pricing)).toBe(0);
  });

  it("缺少用量或单价就是“无法估算”（null），不猜：用量未上报、只上报一半、单价为空", () => {
    expect(estimateCostMicroYuan({ ...call, inputTokens: null, outputTokens: null }, pricing)).toBeNull();
    expect(estimateCostMicroYuan({ ...call, outputTokens: null }, pricing)).toBeNull();
    expect(estimateCostMicroYuan({ ...call, modelId: "unpriced-model" }, pricing)).toBeNull();
    expect(estimateCostMicroYuan(call, { ...pricing, default: { inputPerMillionTokens: null, outputPerMillionTokens: null } })).toBeNull();
  });

  it("用量为 0 的真实调用成本是 0（已知），与无法估算不同", () => {
    expect(estimateCostMicroYuan({ ...call, inputTokens: 0, outputTokens: 0 }, pricing)).toBe(0);
  });

  it("结果取整", () => {
    expect(estimateCostMicroYuan({ ...call, inputTokens: 1, outputTokens: 1 }, { ...pricing, default: { inputPerMillionTokens: 0.4, outputPerMillionTokens: 0.4 } })).toBe(1); // 0.8 → 1
  });
});

let n = 0;
const sample = (over: Partial<UsageSample> = {}): UsageSample => ({
  kind: "ANALYSIS_INTERPRET",
  taskId: `t${++n}`,
  modelId: "m",
  simulated: false,
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1000,
  success: true,
  costMicroYuan: 1000,
  createdAt: new Date("2026-03-10T04:00:00Z"),
  ...over,
});

describe("用量汇总", () => {
  it("总计：调用数、失败数、token、耗时、已知成本之和；无法估算的调用单独计数、不进入成本", () => {
    const s = summarizeUsage([sample(), sample({ success: false, costMicroYuan: 500 }), sample({ costMicroYuan: null, inputTokens: null, outputTokens: null })]);
    expect(s.total).toEqual({ calls: 3, failures: 1, simulatedCalls: 0, inputTokens: 200, outputTokens: 100, durationMs: 3000, costMicroYuan: 1500, unknownCostCalls: 1 });
  });

  it("按北京时间的日期分组，从新到旧：UTC 16:00 之后属于北京时间的第二天", () => {
    const s = summarizeUsage([
      sample({ createdAt: new Date("2026-03-10T15:59:00Z") }), // 北京 03-10 23:59
      sample({ createdAt: new Date("2026-03-10T16:00:00Z") }), // 北京 03-11 00:00
      sample({ createdAt: new Date("2026-03-11T02:00:00Z") }),
    ]);
    expect(s.byDay.map((d) => [d.day, d.calls])).toEqual([["2026-03-11", 2], ["2026-03-10", 1]]);
  });

  it("按类型与按模型分组；同名模型的模拟与真实分开统计", () => {
    const s = summarizeUsage([sample({ kind: "RECOGNITION" }), sample({ kind: "ANALYSIS_EXTRACT" }), sample({ kind: "ANALYSIS_EXTRACT" }), sample({ modelId: "mock", simulated: true, costMicroYuan: 0 }), sample({ modelId: "mock", simulated: false })]);
    expect(Object.fromEntries(s.byKind.map((k) => [k.kind, k.calls]))).toEqual({ ANALYSIS_EXTRACT: 2, ANALYSIS_INTERPRET: 2, RECOGNITION: 1 });
    expect(s.byModel.map((m) => [m.modelId, m.simulated, m.calls])).toEqual([["m", false, 3], ["mock", false, 1], ["mock", true, 1]]);
  });

  it("每次分析的平均成本：一次分析的所有调用（提取与解释，含失败的）加总再平均", () => {
    const s = summarizeUsage([
      sample({ taskId: "a1", kind: "ANALYSIS_EXTRACT", costMicroYuan: 1000 }),
      sample({ taskId: "a1", kind: "ANALYSIS_INTERPRET", costMicroYuan: 3000 }),
      sample({ taskId: "a2", kind: "ANALYSIS_EXTRACT", costMicroYuan: 2000, success: false }),
      sample({ taskId: "shot-1", kind: "RECOGNITION", costMicroYuan: 99999 }), // 截图识别不算分析
    ]);
    expect(s.perAnalysis).toEqual({ analyses: 2, withKnownCost: 2, averageMicroYuan: 3000 }); // (4000 + 2000) / 2
  });

  it("只要一次分析里有无法估算的调用，这次分析就不进平均；一份都没有已知成本时平均是 null（无法估算），不是 0", () => {
    const partly = summarizeUsage([
      sample({ taskId: "a1", costMicroYuan: 1000 }),
      sample({ taskId: "a2", kind: "ANALYSIS_EXTRACT", costMicroYuan: 1000 }),
      sample({ taskId: "a2", costMicroYuan: null }),
    ]);
    expect(partly.perAnalysis).toEqual({ analyses: 2, withKnownCost: 1, averageMicroYuan: 1000 });
    const none = summarizeUsage([sample({ taskId: "a1", costMicroYuan: null })]);
    expect(none.perAnalysis).toEqual({ analyses: 1, withKnownCost: 0, averageMicroYuan: null });
  });

  it("全部来自模拟模型时标注（没有真实成本）；混有真实调用则不标；没有记录时不标", () => {
    expect(summarizeUsage([sample({ simulated: true, costMicroYuan: 0 })]).allSimulated).toBe(true);
    expect(summarizeUsage([sample({ simulated: true, costMicroYuan: 0 }), sample()]).allSimulated).toBe(false);
    const empty = summarizeUsage([]);
    expect(empty.allSimulated).toBe(false);
    expect(empty.total.calls).toBe(0);
    expect(empty.perAnalysis.averageMicroYuan).toBeNull();
  });
});
