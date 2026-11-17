import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockAnalysisModel } from "../src/server/ai/mock-analysis";
import { renderEvalReport, runEvalCases, type EvalCase } from "../src/server/analysis/eval";

/** 运行分析流水线的安全评测，并把结果写入 docs/evals/analysis-mock-results.md。失败的用例使进程以非零状态退出。 */
const { cases } = JSON.parse(readFileSync(join("samples", "eval", "analysis-cases.json"), "utf8")) as { cases: EvalCase[] };
const model = createMockAnalysisModel();
const results = await runEvalCases(cases, model);
writeFileSync(join("docs", "evals", "analysis-mock-results.md"), renderEvalReport(results, model, new Date().toISOString().slice(0, 10)) + "\n", "utf8");

for (const r of results) console.log(`${r.passed ? "通过" : "失败"}  ${r.id}`);
const failed = results.filter((r) => !r.passed).length;
console.log(`${results.length - failed}/${results.length} 个用例通过，报告：docs/evals/analysis-mock-results.md`);
process.exit(failed === 0 ? 0 : 1);
