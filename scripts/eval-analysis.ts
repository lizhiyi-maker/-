import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBailianAnalysisModel } from "../src/server/ai/bailian";
import { createMockAnalysisModel } from "../src/server/ai/mock-analysis";
import { renderEvalReport, runEvalCases, type EvalCase } from "../src/server/analysis/eval";

/**
 * 运行分析流水线的安全评测。失败的用例使进程以非零状态退出。
 *   npm run eval:analysis                       模拟模型 → docs/evals/analysis-mock-results.md（默认，离线、免费）
 *   npm run eval:analysis -- --provider bailian 真实百炼文本模型 → docs/evals/analysis-bailian-results.md
 *       需要环境变量 DASHSCOPE_API_KEY、DASHSCOPE_TEXT_MODEL（可选 DASHSCOPE_BASE_URL）。
 *       会把 samples/eval 里的**虚构**聊天发给服务商并产生费用；不要把真实用户聊天放进评测集。
 */
const provider = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : "mock";
const { cases } = JSON.parse(readFileSync(join("samples", "eval", "analysis-cases.json"), "utf8")) as { cases: EvalCase[] };

let model;
let outFile: string;
if (provider === "mock") {
  model = createMockAnalysisModel();
  outFile = "analysis-mock-results.md";
} else if (provider === "bailian") {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const textModel = process.env.DASHSCOPE_TEXT_MODEL;
  if (!apiKey || !textModel) {
    console.error("真实评测需要环境变量 DASHSCOPE_API_KEY 与 DASHSCOPE_TEXT_MODEL");
    process.exit(2);
  }
  console.log(`将向百炼发送 ${cases.length} 个虚构样本（模型 ${textModel}），会产生费用。`);
  model = createBailianAnalysisModel({ apiKey, textModel, visionModel: "unused", baseUrl: process.env.DASHSCOPE_BASE_URL });
  outFile = "analysis-bailian-results.md";
} else {
  console.error(`未知的 --provider：${provider}（可选 mock、bailian）`);
  process.exit(2);
}

const results = await runEvalCases(cases, model);
writeFileSync(join("docs", "evals", outFile), renderEvalReport(results, model, new Date().toISOString().slice(0, 10)) + "\n", "utf8");

for (const r of results) console.log(`${r.passed ? "通过" : "失败"}  ${r.id}`);
const failed = results.filter((r) => !r.passed).length;
console.log(`${results.length - failed}/${results.length} 个用例通过，报告：docs/evals/${outFile}`);
process.exit(failed === 0 ? 0 : 1);
