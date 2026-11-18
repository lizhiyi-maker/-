import { describe, expect, it } from "vitest";
import { computeTrend, type TrendSnapshot } from "@/domain/scoring/trend";
import { scoringRules, type ScoringRules } from "@/domain/analysis/rules";

let n = 0;
const snap = (day: number, score: number | null, over: Partial<TrendSnapshot> = {}): TrendSnapshot => ({
  id: `s${++n}`,
  snapshotAt: new Date(Date.UTC(2026, 2, day)),
  rulesVersion: "v0",
  preferenceVersion: 1,
  score,
  ...over,
});

describe("趋势", () => {
  it("可比较的快照不足 2 份：不足以判断", () => {
    expect(computeTrend([]).kind).toBe("INSUFFICIENT");
    expect(computeTrend([snap(1, 60)]).kind).toBe("INSUFFICIENT");
  });

  it("差值绝对值 ≥ 8 才标上升/下降（恰好 8 分算），否则基本持平", () => {
    expect(computeTrend([snap(1, 60), snap(2, 68)])).toMatchObject({ kind: "UP", delta: 8 });
    expect(computeTrend([snap(1, 68), snap(2, 60)])).toMatchObject({ kind: "DOWN", delta: -8 });
    expect(computeTrend([snap(1, 60), snap(2, 67.9)])).toMatchObject({ kind: "FLAT" });
    expect(computeTrend([snap(1, 60), snap(2, 52.1)])).toMatchObject({ kind: "FLAT" });
    expect(computeTrend([snap(1, 60), snap(2, 60)])).toMatchObject({ kind: "FLAT", delta: 0 });
  });

  it("只看最近至多 3 份：差值是窗口里最新与最早之差，更早的快照不参与", () => {
    // 窗口 = 第 2、3、4 份：80 → 82 → 84，差 4（持平）；若把最早的 50 算进去会是 +34
    const r = computeTrend([snap(1, 50), snap(2, 80), snap(3, 82), snap(4, 84)]);
    expect(r).toMatchObject({ kind: "FLAT", delta: 4 });
    if (r.kind === "FLAT") expect(r.points.map((p) => p.score)).toEqual([80, 82, 84]);
  });

  it("与输入顺序无关：按快照时间排序", () => {
    const list = [snap(1, 50), snap(2, 60), snap(3, 80)];
    const a = computeTrend([list[2], list[0], list[1]]);
    const b = computeTrend(list);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "UP", delta: 30 });
  });

  it("偏好版本不同：分差是口径变化，不显示趋势", () => {
    expect(computeTrend([snap(1, 40), snap(2, 80, { preferenceVersion: 2 })])).toEqual({ kind: "BASELINE_CHANGED", changed: ["preference"] });
  });

  it("规则版本不同：同样是口径变化", () => {
    expect(computeTrend([snap(1, 40), snap(2, 80, { rulesVersion: "v1" })])).toEqual({ kind: "BASELINE_CHANGED", changed: ["rules"] });
    expect(computeTrend([snap(1, 40), snap(2, 80, { rulesVersion: "v1", preferenceVersion: 2 })])).toEqual({ kind: "BASELINE_CHANGED", changed: ["rules", "preference"] });
  });

  it("口径变化之后，同口径的最近两份够了就重新比较，更早的不同口径快照不参与", () => {
    const r = computeTrend([snap(1, 10), snap(2, 60, { preferenceVersion: 2 }), snap(3, 70, { preferenceVersion: 2 })]);
    expect(r).toMatchObject({ kind: "UP", delta: 10 });
    if (r.kind === "UP") expect(r.points).toHaveLength(2);
  });

  it("没有适配分（未五维全已知）的快照不参与比较；最新一份没有适配分则不足以判断", () => {
    expect(computeTrend([snap(1, 50), snap(2, null), snap(3, 70)])).toMatchObject({ kind: "UP", delta: 20 });
    expect(computeTrend([snap(1, 50), snap(2, 70), snap(3, null)]).kind).toBe("INSUFFICIENT");
    expect(computeTrend([snap(1, null), snap(2, null)]).kind).toBe("INSUFFICIENT");
  });

  it("口径变化的判断只针对最新一份之前的那份有分数的快照（中间没有适配分的不算）", () => {
    expect(computeTrend([snap(1, 40), snap(2, null, { preferenceVersion: 2 }), snap(3, 80, { preferenceVersion: 2 })]).kind).toBe("BASELINE_CHANGED");
  });

  it("数值与是否要求同口径来自配置", () => {
    const loose: ScoringRules = { ...scoringRules, trend: { ...scoringRules.trend, minDeltaPoints: 3, maxSnapshots: 2, requireSamePreferenceVersion: false } };
    expect(computeTrend([snap(1, 60), snap(2, 64)], loose)).toMatchObject({ kind: "UP", delta: 4 });
    // 不要求同偏好版本时，偏好不同的快照也能比较
    expect(computeTrend([snap(1, 60), snap(2, 70, { preferenceVersion: 2 })], loose)).toMatchObject({ kind: "UP", delta: 10 });
    // maxSnapshots = 2：只看最近两份
    expect(computeTrend([snap(1, 0), snap(2, 60), snap(3, 62)], loose)).toMatchObject({ kind: "FLAT", delta: 2 });
    // 规则版本仍然要求相同
    expect(computeTrend([snap(1, 60), snap(2, 90, { rulesVersion: "v1" })], loose).kind).toBe("BASELINE_CHANGED");
  });
});
