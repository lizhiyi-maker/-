import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { makePng } from "../support/png";
import { createAccount } from "@/server/account/service";
import { createAdmin, ForbiddenError } from "@/server/admin/service";
import { createAnalysis, type AnalysisJob } from "@/server/analysis/service";
import { createConsent } from "@/server/consent/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { createRecognition, type RecognitionJob } from "@/server/recognition/service";
import { createLocalStorage } from "@/server/storage/local";
import { createUsage } from "@/server/usage/service";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import { createMockVision } from "@/server/ai/mock-vision";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import type { VisionModel } from "@/server/ai/vision";
import type { CostPricing } from "@/domain/cost";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let dir: string;
beforeAll(async () => {
  ctx = await newTestDb();
  dir = mkdtempSync(join(tmpdir(), "rel-usage-"));
});
afterAll(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const priced: CostPricing = { currency: "CNY", pricesVerified: true, notice: "", default: { inputPerMillionTokens: 2, outputPerMillionTokens: 6 }, models: {} };

function env(opts: { model?: AnalysisModel; vision?: VisionModel; pricing?: CostPricing } = {}) {
  const aJobs: AnalysisJob[] = [];
  const rJobs: RecognitionJob[] = [];
  const storage = createLocalStorage({ dir, secret: "test-storage-signing-secret-0123456789" });
  const quota = createQuota(ctx.db);
  const consent = createConsent(ctx.db, { providerId: "mock" });
  const preferences = createPreferences(ctx.db);
  const usage = createUsage(ctx.db, { pricing: opts.pricing });
  const analysis = createAnalysis(ctx.db, { quota, consent, preferences, model: opts.model ?? createMockAnalysisModel(), usage, queue: { enqueue: async (j) => void aJobs.push(j) } });
  const rec = createRecognition(ctx.db, { storage, quota, consent, vision: opts.vision ?? createMockVision(), usage, queue: { enqueue: async (j) => void rJobs.push(j) } });
  return {
    storage,
    usage,
    analysis,
    rec,
    consent,
    imports: createImports(ctx.db, { storage, quota }),
    people: createPeople(ctx.db, { quota }),
    admin: createAdmin(ctx.db, { keys, usage }),
    account: createAccount(ctx.db, { storage }),
    drainAnalysis: async () => {
      while (aJobs.length) await analysis.process(aJobs.shift()!);
    },
    drainRecognition: async () => {
      while (rJobs.length) await rec.processScreenshot(rJobs.shift()!);
    },
  };
}
type E = ReturnType<typeof env>;

let seq = 0;
async function withChat(e: E) {
  const user = await makeUser(ctx.db);
  await e.consent.accept(user.id);
  const person = await e.people.create(user.id, { nickname: `阿青${seq++}` });
  const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" });
  await e.imports.submitText(user.id, batch.id, "[2026-03-01 20:00] 阿青：最近在忙什么？这是一句不应出现在用量记录里的聊天\n[2026-03-01 20:02] 我：加班");
  await e.imports.setLabelRole(user.id, batch.id, "阿青", "OTHER");
  await e.imports.setLabelRole(user.id, batch.id, "我", "SELF");
  await e.imports.confirm(user.id, batch.id);
  return { user, person };
}

describe("分析的用量记录", () => {
  it("每次模型调用记一条：提取事实与按维度解释，带模型、耗时、成功与否；模拟模型记为模拟且成本 0；不含任何聊天内容", async () => {
    const e = env();
    const { user, person } = await withChat(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drainAnalysis();

    const rows = await ctx.db.modelUsage.findMany({ where: { taskId: analysisId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.kind).sort()).toEqual(["ANALYSIS_EXTRACT", "ANALYSIS_INTERPRET"]);
    for (const r of rows) {
      expect(r).toMatchObject({ userId: user.id, modelId: "mock-rule-analysis-v0", simulated: true, success: true, inputTokens: null, outputTokens: null, costMicroYuan: 0 });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    const json = JSON.stringify(rows);
    for (const content of ["最近在忙什么", "加班", "不应出现在用量记录里", person.nickname]) expect(json).not.toContain(content);
  });

  it("真实适配器上报的 token 用量被记录，并按配置单价估算成本；没有上报则成本为空（无法估算）", async () => {
    const base = createMockAnalysisModel();
    const reporting: AnalysisModel = {
      ...base,
      simulated: false,
      id: "real-ish-model",
      async extractFacts(input, c) {
        c?.reportUsage({ inputTokens: 1000, outputTokens: 200 });
        return base.extractFacts(input, c);
      },
      // interpret 不上报用量
    };
    const e = env({ model: reporting, pricing: priced });
    const { user, person } = await withChat(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drainAnalysis();
    const rows = await ctx.db.modelUsage.findMany({ where: { taskId: analysisId } });
    const extract = rows.find((r) => r.kind === "ANALYSIS_EXTRACT")!;
    const interpret = rows.find((r) => r.kind === "ANALYSIS_INTERPRET")!;
    expect(extract).toMatchObject({ simulated: false, inputTokens: 1000, outputTokens: 200, costMicroYuan: 1000 * 2 + 200 * 6 });
    expect(interpret).toMatchObject({ simulated: false, inputTokens: null, outputTokens: null, costMicroYuan: null });
  });

  it("模型调用失败也记一条（失败、耗时），分析按既有规则判失败并退还额度；用量记录不影响额度", async () => {
    const base = createMockAnalysisModel();
    const e = env({ model: { ...base, async extractFacts() { throw new Error("服务商超时"); } } });
    const { user, person } = await withChat(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drainAnalysis();
    expect(await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).toMatchObject({ status: "FAILED", errorCode: "MODEL_FAILED" });
    const rows = await ctx.db.modelUsage.findMany({ where: { taskId: analysisId } });
    expect(rows).toEqual([expect.objectContaining({ kind: "ANALYSIS_EXTRACT", success: false })]);
    expect(JSON.stringify(rows)).not.toContain("服务商超时"); // 不记录异常内容
    expect(await createQuota(ctx.db).getAvailable(user.id, "ANALYSIS")).toBe(8);
  });

  it("用量记录写入失败不影响分析：分析照常成功", async () => {
    const broken = createUsage({ modelUsage: { createMany: async () => { throw new Error("db down"); } } } as never);
    await expect(broken.record([{ userId: "u", kind: "RECOGNITION", taskId: "t", modelId: "m", simulated: true, inputTokens: null, outputTokens: null, durationMs: 1, success: true }])).resolves.toBeUndefined();

    const e = env();
    const { user, person } = await withChat(e);
    const failing = createAnalysis(ctx.db, { quota: createQuota(ctx.db), consent: e.consent, preferences: createPreferences(ctx.db), model: createMockAnalysisModel(), usage: broken, queue: { enqueue: async () => {} } });
    const { analysisId } = await failing.start(user.id, person.id);
    await failing.process({ analysisId, generation: 0 });
    expect((await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).status).toBe("SUCCEEDED");
  });
});

describe("截图识别的用量记录", () => {
  async function withShot(e: E, lines: string) {
    const user = await makeUser(ctx.db);
    await e.consent.accept(user.id);
    const person = await e.people.create(user.id, { nickname: `阿青${seq++}` });
    const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
    const added = await e.rec.addScreenshot(user.id, batch.id, { name: "a.png", bytes: makePng(lines) });
    if (added.status !== "added") throw new Error("应当添加成功");
    await e.rec.start(user.id, batch.id);
    return { user, shotId: added.id };
  }

  it("每次识别调用记一条（成功与失败）；模拟视觉模型记为模拟；不含内容", async () => {
    const e = env();
    const ok = await withShot(e, "阿青：这是一句截图里的聊天内容");
    const bad = await withShot(e, "[[FAIL]]\n阿青：另一句");
    await e.drainRecognition();
    const okRows = await ctx.db.modelUsage.findMany({ where: { taskId: ok.shotId } });
    const badRows = await ctx.db.modelUsage.findMany({ where: { taskId: bad.shotId } });
    expect(okRows).toEqual([expect.objectContaining({ kind: "RECOGNITION", modelId: "mock-vision-v0", simulated: true, success: true, costMicroYuan: 0, userId: ok.user.id })]);
    expect(badRows).toEqual([expect.objectContaining({ kind: "RECOGNITION", success: false })]);
    expect(JSON.stringify([...okRows, ...badRows])).not.toMatch(/聊天内容|另一句/);
  });
});

describe("截图识别的用量记录：没有调用服务商就不记", () => {
  it("原图读取失败（文件不存在）时没有发生服务商调用，不记用量；识别判失败", async () => {
    const e = env();
    const user = await makeUser(ctx.db);
    await e.consent.accept(user.id);
    const person = await e.people.create(user.id, { nickname: `阿青${seq++}` });
    const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
    const added = await e.rec.addScreenshot(user.id, batch.id, { name: "a.png", bytes: makePng("阿青：你好") });
    if (added.status !== "added") throw new Error("应当添加成功");
    const row = await ctx.db.screenshot.findUniqueOrThrow({ where: { id: added.id } });
    await e.storage.delete(row.storageKey); // 原图丢失
    await e.rec.start(user.id, batch.id);
    await e.drainRecognition();
    expect((await ctx.db.screenshot.findUniqueOrThrow({ where: { id: added.id } })).status).toBe("FAILED");
    expect(await ctx.db.modelUsage.count({ where: { taskId: added.id } })).toBe(0);
  });
});

describe("成本汇总（后台）", () => {
  it("只有启用的管理员能看；汇总只含用量与成本", async () => {
    const e = env();
    const admin = await makeUser(ctx.db, { role: "ADMIN" });
    const user = await makeUser(ctx.db);
    const suspended = await makeUser(ctx.db, { role: "ADMIN", status: "SUSPENDED" });
    await e.usage.record([{ userId: user.id, kind: "ANALYSIS_EXTRACT", taskId: "汇总用任务", modelId: "汇总用模型", simulated: false, inputTokens: 10, outputTokens: 5, durationMs: 100, success: true }]);

    const s = await e.admin.costSummary(admin.id, 30);
    expect(s.byModel.find((m) => m.modelId === "汇总用模型")).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 });
    await expect(e.admin.costSummary(user.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(e.admin.costSummary(suspended.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("只统计所选天数内的记录", async () => {
    const e = env();
    const admin = await makeUser(ctx.db, { role: "ADMIN" });
    await e.usage.record([{ userId: null as never, kind: "RECOGNITION", taskId: "近", modelId: "窗口测试模型", simulated: true, inputTokens: null, outputTokens: null, durationMs: 1, success: true }]);
    await ctx.db.modelUsage.create({ data: { kind: "RECOGNITION", taskId: "远", modelId: "窗口测试模型", simulated: true, durationMs: 1, success: true, costMicroYuan: 0, createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    const s = await e.admin.costSummary(admin.id, 30);
    expect(s.byModel.find((m) => m.modelId === "窗口测试模型")!.calls).toBe(1);
    expect((await e.admin.costSummary(admin.id, 60)).byModel.find((m) => m.modelId === "窗口测试模型")!.calls).toBe(2);
  });

  it("账户删除后：成本记录保留但不再关联任何用户（只剩不含身份的用量）", async () => {
    const e = env();
    const { user, person } = await withChat(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drainAnalysis();
    expect(await ctx.db.modelUsage.count({ where: { taskId: analysisId, userId: user.id } })).toBe(2);
    await e.account.deleteAccount(user.id);
    expect(await ctx.db.modelUsage.count({ where: { taskId: analysisId, userId: null } })).toBe(2);
    expect(await ctx.db.modelUsage.count({ where: { userId: user.id } })).toBe(0);
  });
});
