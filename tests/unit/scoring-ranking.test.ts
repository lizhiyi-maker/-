import { describe, expect, it } from "vitest";
import { buildComparison, type RankingCandidate } from "@/domain/scoring/ranking";
import type { DimensionResults } from "@/domain/scoring/score";
import { DIMENSION_KEYS, scoringRules, type ScoringRules } from "@/domain/analysis/rules";

const [A, B, C, D, E] = DIMENSION_KEYS;
const equal = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 3]));

/** known：已知的维度及其等级；其余为“资料不足”。 */
function dims(known: Partial<Record<string, string>>): DimensionResults {
  return Object.fromEntries(DIMENSION_KEYS.map((k) => [k, known[k] ? { status: "known", level: known[k] } : { status: "insufficient" }])) as DimensionResults;
}
const full = (level: string) => dims(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, level])));

let n = 0;
function cand(over: Partial<RankingCandidate> & { id?: string }): RankingCandidate {
  return { id: over.id ?? `p${++n}`, stage: "GETTING_TO_KNOW", explicitRefusal: false, freshness: "FRESH", dimensions: full("fair"), ...over };
}
const run = (candidates: RankingCandidate[], importance = equal, rules?: ScoringRules) => buildComparison(candidates, importance, rules);
const pool = (r: ReturnType<typeof run>, stage = "GETTING_TO_KNOW") => r.pools.find((p) => p.stage === stage);

describe("排名", () => {
  it("同阶段、共同已知维度足够：按适配分从高到低排名", () => {
    const r = run([cand({ id: "low", dimensions: full("weak") }), cand({ id: "high", dimensions: full("very_good") }), cand({ id: "mid", dimensions: full("good") })]);
    expect(pool(r)!.ranked).toEqual([
      expect.objectContaining({ id: "high", rank: 1, score: 100 }),
      expect.objectContaining({ id: "mid", rank: 2, score: 75 }),
      expect.objectContaining({ id: "low", rank: 3, score: 25 }),
    ]);
    expect(pool(r)!.commonDimensions).toEqual([...DIMENSION_KEYS]);
  });

  it("同分并列同名次，下一名次跳号（1、1、3）", () => {
    const r = run([cand({ id: "x", dimensions: full("good") }), cand({ id: "y", dimensions: full("good") }), cand({ id: "z", dimensions: full("fair") })]);
    expect(pool(r)!.ranked.map((x) => [x.id, x.rank, x.tied])).toEqual([["x", 1, true], ["y", 1, true], ["z", 3, false]]);
  });

  it("结果与候选的输入顺序无关（并列时按对象 id 稳定排序）", () => {
    const list = [cand({ id: "c", dimensions: full("good") }), cand({ id: "a", dimensions: full("good") }), cand({ id: "b", dimensions: full("very_good") })];
    const forward = run(list);
    const backward = run([...list].reverse());
    expect(forward).toEqual(backward);
    expect(pool(forward)!.ranked.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("跨阶段不给统一名次：每个阶段各自成池，各排各的", () => {
    const r = run([
      cand({ id: "met-1", stage: "JUST_MET", dimensions: full("very_good") }),
      cand({ id: "met-2", stage: "JUST_MET", dimensions: full("weak") }),
      cand({ id: "know-1", stage: "GETTING_TO_KNOW", dimensions: full("fair") }),
      cand({ id: "know-2", stage: "GETTING_TO_KNOW", dimensions: full("good") }),
    ]);
    expect(r.pools.map((p) => p.stage)).toEqual(["JUST_MET", "GETTING_TO_KNOW"]);
    expect(pool(r, "JUST_MET")!.ranked.map((p) => [p.id, p.rank])).toEqual([["met-1", 1], ["met-2", 2]]);
    expect(pool(r, "GETTING_TO_KNOW")!.ranked.map((p) => [p.id, p.rank])).toEqual([["know-2", 1], ["know-1", 2]]);
  });
});

describe("排名准入", () => {
  it("阶段不是“刚认识/正在了解”的不入池：已确认关系、已结束、阶段未设置；仍可查看记录", () => {
    const r = run([
      cand({ id: "rel", stage: "IN_RELATIONSHIP" }),
      cand({ id: "end", stage: "ENDED" }),
      cand({ id: "none", stage: null }),
      cand({ id: "ok-1" }),
      cand({ id: "ok-2" }),
    ]);
    expect(r.excluded).toEqual(
      expect.arrayContaining([
        { id: "rel", reason: "STAGE_NOT_ELIGIBLE" },
        { id: "end", reason: "STAGE_NOT_ELIGIBLE" },
        { id: "none", reason: "NO_STAGE" },
      ]),
    );
    expect(pool(r)!.ranked.map((p) => p.id).sort()).toEqual(["ok-1", "ok-2"]);
  });

  it("对方明确拒绝的不入池", () => {
    const r = run([cand({ id: "refused", explicitRefusal: true, dimensions: full("very_good") }), cand({ id: "a" }), cand({ id: "b" })]);
    expect(r.excluded).toContainEqual({ id: "refused", reason: "EXPLICIT_REFUSAL" });
    expect(pool(r)!.ranked.map((p) => p.id)).not.toContain("refused");
  });

  it.each(["CORRECTED_EXPIRED", "PREFERENCE_CHANGED", "RULES_CHANGED"] as const)("报告新鲜度是 %s 的不入池（需先重新分析）", (freshness) => {
    const r = run([cand({ id: "stale", freshness, dimensions: full("very_good") }), cand({ id: "a" }), cand({ id: "b" })]);
    expect(r.excluded).toContainEqual({ id: "stale", reason: "STALE_REPORT" });
  });

  it("“有新资料待分析”的报告仍然有效，可以入池；没有分析报告的不入池", () => {
    const r = run([cand({ id: "newdata", freshness: "NEW_DATA" }), cand({ id: "a" }), cand({ id: "never", freshness: null, dimensions: null })]);
    expect(pool(r)!.ranked.map((p) => p.id).sort()).toEqual(["a", "newdata"]);
    expect(r.excluded).toContainEqual({ id: "never", reason: "NO_ANALYSIS" });
  });
});

describe("待了解与共同已知维度", () => {
  it("样例 #10：三个对象各有 4 个已知维度，但共同已知只有 3 个 → 都不排名，全部“待了解”，只展示各自已知的维度", () => {
    const r = run([
      cand({ id: "p", dimensions: dims({ [A]: "good", [B]: "good", [C]: "good", [D]: "good" }) }),
      cand({ id: "q", dimensions: dims({ [A]: "good", [B]: "good", [C]: "good", [E]: "good" }) }),
      cand({ id: "r", dimensions: dims({ [A]: "good", [B]: "good", [C]: "good", [D]: "good" }) }),
    ]);
    const g = pool(r)!;
    expect(g.ranked).toEqual([]);
    expect(g.waiting.map((w) => [w.id, w.reason]).sort()).toEqual([["p", "NOT_COMMON"], ["q", "NOT_COMMON"], ["r", "NOT_COMMON"]]);
    expect(g.waiting.find((w) => w.id === "p")!.known).toEqual([A, B, C, D]);
    expect(g.waiting.find((w) => w.id === "q")!.known).toEqual([A, B, C, E]);
  });

  it("个体已知维度不足 4 个的先进入“待了解”，不拖累其他人排名", () => {
    const r = run([
      cand({ id: "thin", dimensions: dims({ [A]: "very_good", [B]: "very_good", [C]: "very_good" }) }),
      cand({ id: "a", dimensions: full("good") }),
      cand({ id: "b", dimensions: full("fair") }),
    ]);
    const g = pool(r)!;
    expect(g.waiting).toEqual([{ id: "thin", reason: "FEW_KNOWN", known: [A, B, C] }]);
    expect(g.ranked.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("重要程度为 5 的维度必须是已知：缺少它的对象进入“待了解”", () => {
    const imp = { ...equal, [C]: 5 };
    const r = run(
      [
        cand({ id: "no-critical", dimensions: dims({ [A]: "very_good", [B]: "very_good", [D]: "very_good", [E]: "very_good" }) }), // 4 个已知但缺重要维度
        cand({ id: "a", dimensions: full("good") }),
        cand({ id: "b", dimensions: full("fair") }),
      ],
      imp,
    );
    expect(pool(r)!.waiting).toEqual([{ id: "no-critical", reason: "MISSING_CRITICAL", known: [A, B, D, E] }]);
    expect(pool(r)!.ranked.map((p) => p.id)).toEqual(["a", "b"]);
    // 没有重要程度 5 的维度时，同样的对象可以排名
    expect(pool(run([cand({ id: "no-critical", dimensions: dims({ [A]: "very_good", [B]: "very_good", [D]: "very_good", [E]: "very_good" }) }), cand({ id: "a", dimensions: full("good") })]))!.ranked.length).toBe(2);
  });

  it("在共同已知维度上按用户权重重新归一化后比较；缺失的维度不被当作 0 分，也不影响对方", () => {
    // p 五维全知；q 只有 4 个已知（缺 E）。共同维度 = A–D，E 不参与比较。
    const p = dims({ [A]: "fair", [B]: "fair", [C]: "fair", [D]: "fair", [E]: "very_good" });
    const q = dims({ [A]: "good", [B]: "good", [C]: "good", [D]: "good" });
    const r = run([cand({ id: "p", dimensions: p }), cand({ id: "q", dimensions: q })]);
    const g = pool(r)!;
    expect(g.commonDimensions).toEqual([A, B, C, D]);
    expect(g.ranked.map((x) => [x.id, x.rank, x.score])).toEqual([["q", 1, 75], ["p", 2, 50]]); // p 的“很好”在 E 上，不参与
  });

  it("共同维度上的权重重新归一化：重要程度只在共同维度内分摊", () => {
    const imp = { [A]: 1, [B]: 1, [C]: 1, [D]: 3, [E]: 4 };
    const p = dims({ [A]: "very_good", [B]: "very_good", [C]: "very_good", [D]: "very_weak", [E]: "very_weak" });
    const q = dims({ [A]: "fair", [B]: "fair", [C]: "fair", [D]: "fair" }); // 缺 E（E 的重要程度是 4，不是 5，所以不触发“重要维度必须已知”）
    const r = run([cand({ id: "p", dimensions: p }), cand({ id: "q", dimensions: q })], imp);
    const scores = Object.fromEntries(pool(r)!.ranked.map((x) => [x.id, x.score]));
    expect(scores).toEqual({ p: 50, q: 50 }); // p: (100+100+100+0)/6 = 50；q: 50
  });

  it("池里只有一个对象：没有可比较的对象，不排名（也不是“待了解”）", () => {
    const r = run([cand({ id: "solo" }), cand({ id: "other-stage", stage: "JUST_MET" })]);
    expect(pool(r)!.ranked).toEqual([]);
    expect(pool(r)!.unranked).toEqual([{ id: "solo", reason: "NO_PEERS" }]);
    expect(pool(r, "JUST_MET")!.unranked).toEqual([{ id: "other-stage", reason: "NO_PEERS" }]);
  });

  it("阈值来自配置：共同已知维度的下限改为 3 时，样例 #10 可以排名", () => {
    const relaxed: ScoringRules = { ...scoringRules, ranking: { ...scoringRules.ranking, minCommonKnownDimensions: 3 } };
    const list = [
      cand({ id: "p", dimensions: dims({ [A]: "good", [B]: "good", [C]: "good", [D]: "good" }) }),
      cand({ id: "q", dimensions: dims({ [A]: "fair", [B]: "fair", [C]: "fair", [E]: "fair" }) }),
    ];
    expect(pool(run(list))!.ranked).toEqual([]);
    expect(pool(run(list, equal, relaxed))!.ranked.map((x) => x.id)).toEqual(["p", "q"]);
  });
});
