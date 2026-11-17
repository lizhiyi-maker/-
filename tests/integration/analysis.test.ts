import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createAnalysis, type AnalysisJob } from "@/server/analysis/service";
import { createConsent } from "@/server/consent/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { ConsentRequiredError, NotFoundError, ValidationError } from "@/server/errors";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

function env(opts: { model?: AnalysisModel; rulesVersion?: string } = {}) {
  let now = new Date();
  const jobs: AnalysisJob[] = [];
  const quota = createQuota(ctx.db, { now: () => now });
  const consent = createConsent(ctx.db, { providerId: "mock", now: () => now });
  const preferences = createPreferences(ctx.db);
  const model = { current: opts.model ?? createMockAnalysisModel() };
  const delegating: AnalysisModel = {
    get id() {
      return model.current.id;
    },
    get promptVersion() {
      return model.current.promptVersion;
    },
    extractFacts: (i) => model.current.extractFacts(i),
    interpret: (i) => model.current.interpret(i),
  };
  const make = (rulesVersion?: string) =>
    createAnalysis(ctx.db, {
      quota,
      consent,
      preferences,
      model: delegating,
      queue: { enqueue: async (j) => void jobs.push(j) },
      now: () => now,
      rulesVersion: rulesVersion ?? opts.rulesVersion,
    });
  const analysis = make();
  return {
    analysis,
    make,
    quota,
    consent,
    preferences,
    model,
    jobs,
    imports: createImports(ctx.db, { quota }),
    people: createPeople(ctx.db, { quota }),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    drain: async (a = analysis) => {
      while (jobs.length) await a.process(jobs.shift()!);
    },
  };
}
type Env = ReturnType<typeof env>;

let seq = 0;
async function setup(e: Env, opts: { consented?: boolean; chat?: string | null; dataKind?: "CONTINUOUS" | "CURATED" | "UNCERTAIN" } = {}) {
  const user = await makeUser(ctx.db);
  if (opts.consented !== false) await e.consent.accept(user.id);
  const person = await e.people.create(user.id, { nickname: `阿青${seq++}` });
  if (opts.chat !== null) await saveChat(e, user.id, person.id, opts.chat ?? DEFAULT_CHAT, opts.dataKind);
  return { user, person };
}

const DEFAULT_CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班\n[2026-03-02 20:00] 阿青：周末有什么打算吗？\n[2026-03-02 20:03] 我：还没想好";

/** 通过真实的导入流程保存一批聊天（暂存 → 确认身份 → 保存）。 */
async function saveChat(e: Env, userId: string, personId: string, text: string, dataKind: "CONTINUOUS" | "CURATED" | "UNCERTAIN" = "CONTINUOUS") {
  const batch = await e.imports.createBatch(userId, personId, { platform: "WECHAT", dataKind });
  await e.imports.submitText(userId, batch.id, text);
  await e.imports.setLabelRole(userId, batch.id, "阿青", "OTHER");
  await e.imports.setLabelRole(userId, batch.id, "我", "SELF");
  await e.imports.confirm(userId, batch.id);
  return batch.id;
}

const available = (e: Env, userId: string) => e.quota.getAvailable(userId, "ANALYSIS");

describe("提交分析", () => {
  it("未同意不能提交：没有任何内容被提交，额度不动", async () => {
    const e = env();
    const { user, person } = await setup(e, { consented: false });
    await expect(e.analysis.start(user.id, person.id)).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(e.jobs).toHaveLength(0);
    expect(await available(e, user.id)).toBe(8);
    expect(await ctx.db.analysis.count({ where: { personId: person.id } })).toBe(0);
  });

  it("需要有已保存的资料：没有，或只有未确认的暂存资料，都不能提交", async () => {
    const e = env();
    const { user, person } = await setup(e, { chat: null });
    await expect(e.analysis.start(user.id, person.id)).rejects.toBeInstanceOf(ValidationError);
    const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" });
    await e.imports.submitText(user.id, batch.id, "阿青：你好吗？");
    await expect(e.analysis.start(user.id, person.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await available(e, user.id)).toBe(8);
  });

  it("提交时预留 1 次分析额度并入队；记录模型、提示词、规则、偏好版本和输入资料快照；已有进行中的分析时不能重复提交", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    expect(e.jobs).toHaveLength(1);
    expect(await available(e, user.id)).toBe(7);

    const row = await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(row).toMatchObject({ status: "QUEUED", modelId: "mock-rule-analysis-v0", promptVersion: "analysis-prompt-v0-mock", rulesVersion: "v0-experimental", preferenceVersion: 0, messageCount: 4 });
    const refs = row.snapshotRefs as { id: string; revision: number; batchId: string; dataKind: string }[];
    expect(refs).toHaveLength(4);
    expect(refs.every((r) => r.revision === 1 && r.dataKind === "CONTINUOUS")).toBe(true);

    await expect(e.analysis.start(user.id, person.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await available(e, user.id)).toBe(7);
    expect(e.jobs).toHaveLength(1);
  });

  it("额度不足时拒绝，不留下分析记录", async () => {
    const e = env();
    const { user, person } = await setup(e);
    await e.quota.reserve(user.id, "ANALYSIS", 8, "used-up");
    await expect(e.analysis.start(user.id, person.id)).rejects.toThrow();
    expect(await ctx.db.analysis.count({ where: { personId: person.id } })).toBe(0);
    expect(e.jobs).toHaveLength(0);
  });
});

describe("执行分析与报告", () => {
  it("成功：保存校验后的结果，额度结算，报告为“最新”，所有引用都能回查到快照里的真实消息", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drain();
    expect(await available(e, user.id)).toBe(7);

    const report = await e.analysis.getReport(user.id, person.id);
    expect(report.running).toBeNull();
    expect(report.freshness).toBe("FRESH");
    expect(report.latest).toMatchObject({ id: analysisId, messageCount: 4, rulesVersion: "v0-experimental" });
    const out = report.latest!.output;
    expect(Object.keys(out.dimensions).sort()).toEqual([...DIMENSION_KEYS].sort());
    expect(out.suggestions.length).toBeLessThanOrEqual(3);

    const snapshotIds = new Set(((await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).snapshotRefs as { id: string }[]).map((r) => r.id));
    const refs = Object.values(out.dimensions).flatMap((d) => [...d.observedFacts, ...d.supporting, ...d.counter].flatMap((f) => f.refs));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(snapshotIds.has(r.messageId)).toBe(true);

    // 证据展开：引用的消息内容与上下文
    const evidence = await e.analysis.loadEvidence(user.id, analysisId);
    const first = evidence[`${refs[0].messageId}:${refs[0].revision}`];
    expect(first.content).toMatch(/？/);
    expect(first.speaker).toBe("OTHER");
  });

  it("没有进行中也没有成功的分析时，报告为空", async () => {
    const e = env();
    const { user, person } = await setup(e);
    expect(await e.analysis.getReport(user.id, person.id)).toMatchObject({ running: null, latest: null, freshness: null });
  });

  it("进行中的分析在报告里可见（用于刷新后恢复进度）", async () => {
    const e = env();
    const { user, person } = await setup(e);
    await e.analysis.start(user.id, person.id);
    expect((await e.analysis.getReport(user.id, person.id)).running).toMatchObject({ status: "QUEUED" });
    const restarted = e.make();
    expect((await restarted.getReport(user.id, person.id)).running).toMatchObject({ status: "QUEUED" });
  });

  it("长聊天分段处理，保留可回查的原始消息引用", async () => {
    const e = env();
    const lines: string[] = [];
    for (let d = 1; d <= 28; d++) {
      const day = String(d).padStart(2, "0");
      lines.push(`[2026-02-${day} 20:00] 阿青：今天过得怎么样？`, `[2026-02-${day} 20:02] 我：还不错`, `[2026-02-${day} 20:05] 阿青：吃饭了吗？`, `[2026-02-${day} 20:06] 我：吃了`);
    }
    const { user, person } = await setup(e, { chat: lines.join("\n") });
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drain();
    const row = await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(row.status).toBe("SUCCEEDED");
    expect((row.meta as { segments: number }).segments).toBeGreaterThan(1);
    expect(row.messageCount).toBe(112);
  });

  it("同一任务被重复投递只处理一次，额度只结算一次", async () => {
    const e = env();
    const { user, person } = await setup(e);
    await e.analysis.start(user.id, person.id);
    const job = e.jobs.shift()!;
    await Promise.all([e.analysis.process(job), e.analysis.process(job)]);
    await e.analysis.process(job);
    expect(await ctx.db.analysis.count({ where: { personId: person.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await available(e, user.id)).toBe(7);
  });
});

describe("失败与重试", () => {
  it("模型失败：不扣额度，旧报告保留；用户再次提交会用新的任务键，只扣一次", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const first = await e.analysis.start(user.id, person.id);
    await e.drain();
    expect(await available(e, user.id)).toBe(7);

    e.model.current = { ...createMockAnalysisModel(), async extractFacts() { throw new Error("服务商超时"); } };
    const failed = await e.analysis.start(user.id, person.id);
    expect(await available(e, user.id)).toBe(6);
    await e.drain();
    expect(await available(e, user.id)).toBe(7); // 失败退还
    expect(await ctx.db.analysis.findUniqueOrThrow({ where: { id: failed.analysisId } })).toMatchObject({ status: "FAILED", errorCode: "MODEL_FAILED" });
    expect((await e.analysis.getReport(user.id, person.id)).latest?.id).toBe(first.analysisId);

    e.model.current = createMockAnalysisModel();
    const retry = await e.analysis.start(user.id, person.id);
    expect(retry.analysisId).not.toBe(failed.analysisId);
    await e.drain();
    expect(await available(e, user.id)).toBe(6);
    expect((await e.analysis.getReport(user.id, person.id)).latest?.id).toBe(retry.analysisId);
  });

  it("模型编造引用：整次分析判为失败，不入库，额度退还", async () => {
    const e = env({
      model: {
        ...createMockAnalysisModel(),
        async interpret(input) {
          const out = (await createMockAnalysisModel().interpret(input)) as { dimensions: Record<string, { observedFacts: unknown[] }> };
          out.dimensions.willingness_to_know.observedFacts = [{ text: "编造", refs: ["M9999"] }];
          return out;
        },
      },
    });
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.drain();
    const row = await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(row).toMatchObject({ status: "FAILED", errorCode: "INVALID_OUTPUT", output: null });
    expect(await available(e, user.id)).toBe(8);
  });

  it("排队超过 15 分钟没有结果的分析判为失败并退还额度", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    e.jobs.length = 0; // 模拟 worker 崩溃：任务丢失
    await e.analysis.sweepStuck();
    expect((await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).status).toBe("QUEUED");
    e.advance(16 * 60_000);
    expect(await e.analysis.sweepStuck()).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT" });
    expect(await available(e, user.id)).toBe(8);
  });
});

describe("报告新鲜度", () => {
  async function withReport(e: Env) {
    const s = await setup(e);
    const { analysisId } = await e.analysis.start(s.user.id, s.person.id);
    await e.drain();
    return { ...s, analysisId };
  }

  it("新增资料后显示“有新资料待分析”；旧报告保留并注明资料截止时间；新增资料不会自动分析", async () => {
    const e = env();
    const { user, person, analysisId } = await withReport(e);
    e.advance(1000);
    await saveChat(e, user.id, person.id, "[2026-03-10 20:00] 阿青：你好吗？\n[2026-03-10 20:01] 我：好的");
    const r = await e.analysis.getReport(user.id, person.id);
    expect(r.freshness).toBe("NEW_DATA");
    expect(r.latest?.id).toBe(analysisId);
    expect(r.latest?.snapshotAt).toBeInstanceOf(Date);
    expect(e.jobs).toHaveLength(0);
  });

  it("修改偏好后显示“偏好变更待更新”，且不改变旧报告里记录的偏好版本", async () => {
    const e = env();
    const { user, person } = await withReport(e);
    const equal = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 3]));
    await e.preferences.save(user.id, { importance: { ...equal, follow_through: 5 } });
    const r = await e.analysis.getReport(user.id, person.id);
    expect(r.freshness).toBe("PREFERENCE_CHANGED");
    expect(r.latest?.preferenceVersion).toBe(0);
  });

  it("规则版本升级后显示“规则变更”", async () => {
    const e = env();
    const { user, person } = await withReport(e);
    const upgraded = e.make("v1-active");
    expect((await upgraded.getReport(user.id, person.id)).freshness).toBe("RULES_CHANGED");
  });

  it("报告引用的消息被修改后显示“资料纠正已过期”；快照仍能回查当时引用的修订内容", async () => {
    const e = env();
    const { user, person, analysisId } = await withReport(e);
    const report = (await e.analysis.getReport(user.id, person.id)).latest!;
    const ref = Object.values(report.output.dimensions).flatMap((d) => d.observedFacts.flatMap((f) => f.refs))[0];
    const original = (await e.analysis.loadEvidence(user.id, analysisId))[`${ref.messageId}:${ref.revision}`].content;

    await e.imports.editMessage(user.id, ref.messageId, { content: "（用户纠正后的内容）" });
    expect((await e.analysis.getReport(user.id, person.id)).freshness).toBe("CORRECTED_EXPIRED");
    const after = (await e.analysis.loadEvidence(user.id, analysisId))[`${ref.messageId}:${ref.revision}`];
    expect(after.content).toBe(original); // 引用的是当时的修订
    expect(after).toMatchObject({ revision: 1, currentRevision: 2 });
  });

  it("报告引用的批次被删除后显示“资料纠正已过期”", async () => {
    const e = env();
    const { user, person } = await withReport(e);
    const batch = await ctx.db.importBatch.findFirstOrThrow({ where: { personId: person.id } });
    await e.imports.deleteBatch(user.id, batch.id);
    expect((await e.analysis.getReport(user.id, person.id)).freshness).toBe("CORRECTED_EXPIRED");
  });

  it("首页待办：有资料但从未分析 → 待分析；有新资料 → 有新资料待分析；最新的不出现；正在分析的不出现", async () => {
    const e = env();
    const never = await setup(e);
    const stale = await withReport(e);
    e.advance(1000);
    await saveChat(e, stale.user.id, stale.person.id, "[2026-03-10 20:00] 阿青：你好吗？\n[2026-03-10 20:01] 我：好的");
    const fresh = await withReport(e);
    const running = await setup(e);
    await e.analysis.start(running.user.id, running.person.id);

    expect(await e.analysis.listTodo(never.user.id)).toEqual([expect.objectContaining({ personId: never.person.id, reason: "NEVER" })]);
    expect(await e.analysis.listTodo(stale.user.id)).toEqual([expect.objectContaining({ personId: stale.person.id, reason: "NEW_DATA" })]);
    expect(await e.analysis.listTodo(fresh.user.id)).toEqual([]);
    expect(await e.analysis.listTodo(running.user.id)).toEqual([]);
  });
});

describe("删除围栏与资料变化", () => {
  it("对象删除后，迟到的分析任务不能写回，已预留的额度退还", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.people.remove(user.id, person.id);
    await e.drain();
    expect(await ctx.db.analysis.count({ where: { id: analysisId } })).toBe(0);
    expect(await available(e, user.id)).toBe(8);
  });

  it("分析进行中删除对象：结果被丢弃，额度退还", async () => {
    const e = env();
    const { user, person } = await setup(e);
    await e.analysis.start(user.id, person.id);
    e.model.current = {
      ...createMockAnalysisModel(),
      async extractFacts(input) {
        await e.people.remove(user.id, person.id); // 分析期间用户删除了对象
        return createMockAnalysisModel().extractFacts(input);
      },
    };
    await e.drain();
    expect(await ctx.db.analysis.count({ where: { personId: person.id } })).toBe(0);
    expect(await available(e, user.id)).toBe(8);
  });

  it("分析期间资料被删除：结果作废（INVALIDATED），额度退还", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    const batch = await ctx.db.importBatch.findFirstOrThrow({ where: { personId: person.id } });
    e.model.current = {
      ...createMockAnalysisModel(),
      async interpret(input) {
        await e.imports.deleteBatch(user.id, batch.id);
        return createMockAnalysisModel().interpret(input);
      },
    };
    await e.drain();
    expect((await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).status).toBe("INVALIDATED");
    expect(await available(e, user.id)).toBe(8);
  });

  it("分析期间资料被用户纠正：结果作废，额度退还（不把基于旧资料的结论当作最新）", async () => {
    const e = env();
    const { user, person } = await setup(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    const msg = await ctx.db.message.findFirstOrThrow({ where: { personId: person.id } });
    e.model.current = {
      ...createMockAnalysisModel(),
      async interpret(input) {
        await e.imports.editMessage(user.id, msg.id, { content: "纠正后的内容" });
        return createMockAnalysisModel().interpret(input);
      },
    };
    await e.drain();
    expect((await ctx.db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).status).toBe("INVALIDATED");
    expect(await available(e, user.id)).toBe(8);
  });
});

describe("用户归属", () => {
  it("B 无法为 A 的对象提交分析，也读不到 A 的报告与证据", async () => {
    const e = env();
    const a = await setup(e);
    const b = await makeUser(ctx.db);
    await e.consent.accept(b.id);
    const { analysisId } = await e.analysis.start(a.user.id, a.person.id);
    await e.drain();

    await expect(e.analysis.start(b.id, a.person.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.analysis.getReport(b.id, a.person.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.analysis.loadEvidence(b.id, analysisId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await e.analysis.listTodo(b.id)).toEqual([]);
    expect((await e.analysis.getReport(a.user.id, a.person.id)).latest?.id).toBe(analysisId);
  });
});
