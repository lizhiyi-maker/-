import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "@/lib/env";

// 配置漂移守卫：环境变量的“代码定义”“.env.example”“部署文档”必须一致。
// 只检查变量名是否被提到，不检查文档说得对不对（那要人读）。
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// NODE_ENV 由运行环境/镜像设定，不进 .env.example
const EXAMPLE_EXEMPT = new Set(["NODE_ENV"]);

/** .env.example 里的变量名：既包含 `KEY=` 也包含被注释掉的 `# KEY=`。 */
function exampleKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe("环境变量：代码、.env.example、部署文档一致", () => {
  const example = exampleKeys(read(".env.example"));
  const deployDoc = read("docs", "deploy", "README.md");

  it("代码里定义的每个变量都写在 .env.example 里（NODE_ENV 除外）", () => {
    const missing = ENV_KEYS.filter((k) => !EXAMPLE_EXEMPT.has(k) && !example.has(k));
    expect(missing).toEqual([]);
  });

  it(".env.example 里出现的变量都是代码认识的（防止留着已废弃的变量）", () => {
    const known = new Set<string>(ENV_KEYS);
    const unknown = [...example].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it("部署文档提到了代码里定义的每个变量", () => {
    const missing = ENV_KEYS.filter((k) => !deployDoc.includes(k));
    expect(missing).toEqual([]);
  });

  it("变量清单不是空的（防止 ENV_KEYS 失效而让上面的检查空转）", () => {
    expect(ENV_KEYS.length).toBeGreaterThan(10);
    expect(ENV_KEYS).toContain("APP_MODE");
  });
});
