import { describe, expect, it } from "vitest";
import { computeFitScore, isKnown, knownDimensions, weightedScore, type DimensionResults } from "@/domain/scoring/score";
import { DIMENSION_KEYS, scoringRules, type ScoringRules } from "@/domain/analysis/rules";

const [A, B, C, D, E] = DIMENSION_KEYS;
const equal = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 3]));

/** 构造五个维度；levels 里没给的维度为“资料不足”。 */
function dims(levels: Partial<Record<string, string>>, status: Partial<Record<string, "known" | "clue" | "insufficient">> = {}): DimensionResults {
  return Object.fromEntries(
    DIMENSION_KEYS.map((k) => [k, levels[k] ? { status: status[k] ?? "known", level: levels[k] } : { status: status[k] ?? "insufficient" }]),
  ) as DimensionResults;
}
const all = (level: string) => dims(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, level])));

describe("适配分", () => {
  it("等级按配置换算为分值：五维全“已知”、默认等权时是分值的平均", () => {
    expect(computeFitScore(all("good"), equal)).toMatchObject({ kind: "scored", score: 75 });
    expect(computeFitScore(all("very_weak"), equal)).toMatchObject({ kind: "scored", score: 0 });
    expect(computeFitScore(all("very_good"), equal)).toMatchObject({ kind: "scored", score: 100 });
    // 0 / 25 / 50 / 75 / 100 的平均 = 50
    expect(computeFitScore(dims({ [A]: "very_weak", [B]: "weak", [C]: "fair", [D]: "good", [E]: "very_good" }), equal)).toMatchObject({ score: 50 });
  });

  it("权重 = 该维度重要程度 ÷ 五项重要程度之和，保留 1 位小数", () => {
    // (3×50×4 + 5×100) / (3×4 + 5) = 1100 / 17 = 64.705…
    const r = computeFitScore(dims({ [A]: "fair", [B]: "fair", [C]: "very_good", [D]: "fair", [E]: "fair" }), { ...equal, [C]: 5 });
    expect(r).toMatchObject({ kind: "scored", score: 64.7 });
    // 把重要程度调低，分数向其余维度移动
    const low = computeFitScore(dims({ [A]: "fair", [B]: "fair", [C]: "very_good", [D]: "fair", [E]: "fair" }), { ...equal, [C]: 1 });
    expect(low).toMatchObject({ score: 53.8 }); // (3×50×4 + 1×100) / 13 = 53.84…
  });

  it("恰好在小数中点时四舍五入（向上），不受浮点误差影响", () => {
    // 重要程度 2,1,1,1,3（和为 8）：2×25 / 8 = 6.25 → 6.3
    const r = computeFitScore(dims({ [A]: "weak", [B]: "very_weak", [C]: "very_weak", [D]: "very_weak", [E]: "very_weak" }), { [A]: 2, [B]: 1, [C]: 1, [D]: 1, [E]: 3 });
    expect(r).toMatchObject({ score: 6.3 });
  });

  it("只要有一个维度不是“已知”就不出适配分：资料不足不是 0 分，也不会被忽略后放大剩余得分", () => {
    const four = dims({ [A]: "very_good", [B]: "very_good", [C]: "very_good", [D]: "very_good" }); // 第五个资料不足
    const r = computeFitScore(four, equal);
    expect(r.kind).toBe("unscored");
    if (r.kind === "unscored") {
      expect(r.known).toEqual([A, B, C, D]);
      expect(r.notKnown).toEqual([E]);
    }
    // 线索也不计分
    expect(computeFitScore(dims(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, "good"])), { [E]: "clue" }), equal).kind).toBe("unscored");
    // 对照：补成“已知”才有分数；若缺失被当作 0，分数会是 60，被忽略后放大则是 100
    expect(computeFitScore(all("very_good"), equal)).toMatchObject({ score: 100 });
  });

  it("没有合法等级的“已知”不算已知；非“已知”维度携带的等级被忽略", () => {
    expect(isKnown({ status: "known" })).toBe(false);
    expect(isKnown({ status: "known", level: "excellent" })).toBe(false);
    expect(isKnown({ status: "clue", level: "good" })).toBe(false);
    expect(isKnown(undefined)).toBe(false);
    expect(isKnown({ status: "known", level: "good" })).toBe(true);
    const r = computeFitScore({ ...all("good"), [A]: { status: "known" } }, equal);
    expect(r.kind).toBe("unscored");
    expect(knownDimensions(dims({ [A]: "good", [B]: "good" }, { [B]: "clue" }))).toEqual([A]);
  });

  it("确定性：相同的分析结果与偏好得到相同的分数，与对象键顺序无关", () => {
    const d = dims({ [A]: "good", [B]: "weak", [C]: "fair", [D]: "very_good", [E]: "good" });
    const reversed = Object.fromEntries(Object.entries(d).reverse()) as DimensionResults;
    const imp = { [A]: 1, [B]: 5, [C]: 2, [D]: 4, [E]: 3 };
    expect(computeFitScore(d, imp)).toEqual(computeFitScore(reversed, Object.fromEntries(Object.entries(imp).reverse())));
    expect(computeFitScore(d, imp)).toEqual(computeFitScore(structuredClone(d), { ...imp }));
  });

  it("缺少某维度的重要程度时使用默认值；偏好之外的键被忽略", () => {
    expect(computeFitScore(all("good"), { [A]: 5 })).toMatchObject({ score: 75 });
    const partial = computeFitScore(dims({ [A]: "very_good", [B]: "very_weak", [C]: "very_weak", [D]: "very_weak", [E]: "very_weak" }), { [A]: 5, 不存在的维度: 5 });
    expect(partial).toMatchObject({ score: 29.4 }); // 5×100 / (5+3×4) = 29.41…
  });

  it("数值来自配置而不是写死在代码里：换一套规则，分值与小数位随之变化", () => {
    const custom: ScoringRules = {
      ...scoringRules,
      levels: scoringRules.levels.map((l) => ({ ...l, score: l.score / 10 })),
      total: { ...scoringRules.total, scoreDecimals: 2 },
    };
    expect(computeFitScore(dims({ [A]: "good", [B]: "good", [C]: "good", [D]: "good", [E]: "weak" }), equal, custom)).toMatchObject({ score: 6.5 });
    const three = dims({ [A]: "good", [B]: "fair", [C]: "fair" });
    const imp = { ...equal, [A]: 1 }; // (1×7.5 + 3×5 + 3×5) / 7 = 5.357…
    expect(weightedScore(three, [A, B, C], imp, custom)).toBe(5.36);
    expect(weightedScore(three, [A, B, C], imp, { ...custom, total: { ...custom.total, scoreDecimals: 1 } })).toBe(5.4);
  });
});
