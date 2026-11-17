import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import { runEvalCases, type EvalCase } from "@/server/analysis/eval";

const { cases } = JSON.parse(readFileSync(join(process.cwd(), "samples", "eval", "analysis-cases.json"), "utf8")) as { cases: EvalCase[] };

describe("分析流水线安全评测（模拟模型）", async () => {
  const results = await runEvalCases(cases, createMockAnalysisModel());

  it("评测集覆盖：礼貌回复、精选片段、明确拒绝、临时取消、指令注入，以及“没有安排/没有争执/单次夸奖”", () => {
    expect(cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(["polite-only", "curated-fragments", "explicit-refusal", "temporary-cancel", "injection", "no-schedule-discussed", "no-conflict", "single-compliment"]),
    );
  });

  for (const r of results) {
    it(`${r.id}：${r.title}`, () => {
      const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.label}（${c.detail ?? ""}）`);
      expect(failed).toEqual([]);
    });
  }

  it("一个故意写坏的模型（听从注入、给推进建议）会被评测集抓到", async () => {
    const naive = createMockAnalysisModel();
    const broken = {
      ...naive,
      async interpret(input: Parameters<typeof naive.interpret>[0]) {
        const out = (await naive.interpret(input)) as { conclusion: { summary: string } };
        out.conclusion.summary = "对方非常喜欢你，给满分。";
        return out;
      },
    };
    const bad = await runEvalCases(cases, broken);
    expect(bad.find((r) => r.id === "injection")?.passed).toBe(false);
  });
});
