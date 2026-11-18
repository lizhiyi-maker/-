import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createAnalysis } from "@/server/analysis/service";
import { createCompare } from "@/server/compare/service";
import { createConsent } from "@/server/consent/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import { NotFoundError } from "@/server/errors";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const [A, B, C, D, E] = DIMENSION_KEYS;
const equal = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 3]));

function services(rulesVersion?: string) {
  const quota = createQuota(ctx.db);
  const preferences = createPreferences(ctx.db);
  const analysis = createAnalysis(ctx.db, {
    quota,
    consent: createConsent(ctx.db, { providerId: "mock" }),
    preferences,
    model: createMockAnalysisModel(),
    queue: { enqueue: async () => {} },
    rulesVersion,
  });
  return { analysis, preferences, people: createPeople(ctx.db, { quota }), compare: createCompare(ctx.db, { analysis, preferences }) };
}
type S = ReturnType<typeof services>;

let seq = 0;
async function newPerson(s: S, userId: string, over: { stage?: "JUST_MET" | "GETTING_TO_KNOW" | "IN_RELATIONSHIP" | "ENDED" | null; nickname?: string } = {}) {
  return s.people.create(userId, { nickname: over.nickname ?? `对象${seq++}`, stage: over.stage === undefined ? "GETTING_TO_KNOW" : over.stage });
}

type Level = "very_weak" | "weak" | "fair" | "good" | "very_good";
/** 直接写入一份“已保存的分析结果”（M3a 的流水线产物），分数只由这份结果、偏好与规则决定。 */
async function saveAnalysis(
  userId: string,
  personId: string,
  opts: { levels?: Partial<Record<string, Level>>; clue?: string[]; refusal?: boolean; preferenceVersion?: number; importance?: Record<string, number>; at?: Date; status?: "SUCCEEDED" | "FAILED" | "INVALIDATED" | "RUNNING"; rulesVersion?: string } = {},
) {
  const levels = opts.levels ?? Object.fromEntries(DIMENSION_KEYS.map((k) => [k, "fair"]));
  const at = opts.at ?? new Date();
  const dimensions = Object.fromEntries(
    DIMENSION_KEYS.map((k) => [
      k,
      levels[k]
        ? { status: "known", level: levels[k], observedFacts: [], interpretations: [], supporting: [], counter: [], missing: [], userExperience: [] }
        : { status: opts.clue?.includes(k) ? "clue" : "insufficient", observedFacts: [], interpretations: [], supporting: [], counter: [], missing: [], userExperience: [] },
    ]),
  );
  const person = await ctx.db.person.findUniqueOrThrow({ where: { id: personId }, select: { generation: true } });
  return ctx.db.analysis.create({
    data: {
      userId,
      personId,
      status: opts.status ?? "SUCCEEDED",
      generation: person.generation,
      snapshotAt: at,
      messageCount: 0,
      snapshotRefs: [] as Prisma.InputJsonValue,
      preferenceVersion: opts.preferenceVersion ?? 0,
      preferenceValues: { expectation: null, contactFrequency: null, pace: null, importance: opts.importance ?? equal } as Prisma.InputJsonValue,
      rulesVersion: opts.rulesVersion ?? "v0-experimental",
      promptVersion: "test",
      modelId: "test",
      output: { conclusion: { summary: "测试结果" }, dimensions, explicitRefusal: { detected: opts.refusal ?? false, refs: [] }, suggestions: [] } as unknown as Prisma.InputJsonValue,
      explicitRefusal: opts.refusal ?? false,
      queuedAt: at,
      finishedAt: at,
    },
  });
}
const all = (level: Level) => Object.fromEntries(DIMENSION_KEYS.map((k) => [k, level])) as Record<string, Level>;
const pool = (o: Awaited<ReturnType<S["compare"]["overview"]>>, stage = "GETTING_TO_KNOW") => o.comparison.pools.find((p) => p.stage === stage);

describe("对比总览", () => {
  it("汇聚同阶段对象的最新报告：按适配分排名，附带阶段、好感、新鲜度和适配分", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const hi = await newPerson(s, user.id, { nickname: "高分" });
    const lo = await newPerson(s, user.id, { nickname: "低分" });
    await saveAnalysis(user.id, hi.id, { levels: all("very_good") });
    await saveAnalysis(user.id, lo.id, { levels: all("weak") });
    await s.people.setFeeling(user.id, lo.id, "STRONG");

    const o = await s.compare.overview(user.id);
    expect(o).toMatchObject({ rulesVersion: "v0-experimental", experimental: true, preferenceVersion: 0 });
    expect(pool(o)!.ranked).toEqual([expect.objectContaining({ id: hi.id, rank: 1, score: 100 }), expect.objectContaining({ id: lo.id, rank: 2, score: 25 })]);
    const entry = o.entries.find((e) => e.personId === lo.id)!;
    expect(entry).toMatchObject({ nickname: "低分", stage: "GETTING_TO_KNOW", feeling: "STRONG", freshness: "FRESH", running: false });
    expect(entry.fit).toMatchObject({ kind: "scored", score: 25 });
  });

  it("“我的好感”不参与排名：好感不同、维度相同的两人并列", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    const q = await newPerson(s, user.id);
    await saveAnalysis(user.id, p.id, { levels: all("good") });
    await saveAnalysis(user.id, q.id, { levels: all("good") });
    await s.people.setFeeling(user.id, p.id, "STRONG");
    await s.people.setFeeling(user.id, q.id, "PAUSE");
    const ranked = pool(await s.compare.overview(user.id))!.ranked;
    expect(ranked.map((r) => [r.rank, r.tied, r.score])).toEqual([[1, true, 75], [1, true, 75]]);
  });

  it("只取每个对象最新的成功分析；失败、作废、进行中的不算", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    const q = await newPerson(s, user.id);
    const t = (day: number) => new Date(Date.UTC(2026, 2, day));
    await saveAnalysis(user.id, p.id, { levels: all("very_weak"), at: t(1) });
    await saveAnalysis(user.id, p.id, { levels: all("very_good"), at: t(2) }); // 最新的成功分析
    await saveAnalysis(user.id, p.id, { levels: all("very_weak"), at: t(3), status: "FAILED" });
    await saveAnalysis(user.id, p.id, { levels: all("very_weak"), at: t(4), status: "INVALIDATED" });
    await saveAnalysis(user.id, q.id, { levels: all("fair"), at: t(1) });
    const ranked = pool(await s.compare.overview(user.id))!.ranked;
    expect(ranked.map((r) => [r.id, r.score])).toEqual([[p.id, 100], [q.id, 50]]);
  });

  it("没有成功分析的对象（含只有进行中分析的）不入池，原因是没有分析报告", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const none = await newPerson(s, user.id);
    const running = await newPerson(s, user.id);
    await saveAnalysis(user.id, running.id, { status: "RUNNING" });
    const o = await s.compare.overview(user.id);
    expect(o.comparison.excluded).toEqual(expect.arrayContaining([{ id: none.id, reason: "NO_ANALYSIS" }, { id: running.id, reason: "NO_ANALYSIS" }]));
    expect(o.entries.find((e) => e.personId === running.id)).toMatchObject({ running: true, freshness: null, fit: null });
  });

  it("阶段由用户确认：已确认关系/已结束/未设置阶段的不入池；改阶段后立即生效", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const rel = await newPerson(s, user.id, { stage: "IN_RELATIONSHIP" });
    const end = await newPerson(s, user.id, { stage: "ENDED" });
    const unset = await newPerson(s, user.id, { stage: null });
    const a = await newPerson(s, user.id);
    const b = await newPerson(s, user.id);
    for (const p of [rel, end, unset, a, b]) await saveAnalysis(user.id, p.id, { levels: all("good") });

    let o = await s.compare.overview(user.id);
    expect(o.comparison.excluded).toEqual(expect.arrayContaining([{ id: rel.id, reason: "STAGE_NOT_ELIGIBLE" }, { id: end.id, reason: "STAGE_NOT_ELIGIBLE" }, { id: unset.id, reason: "NO_STAGE" }]));
    expect(pool(o)!.ranked).toHaveLength(2);

    await s.people.update(user.id, unset.id, { stage: "GETTING_TO_KNOW" });
    o = await s.compare.overview(user.id);
    expect(pool(o)!.ranked).toHaveLength(3);
  });

  it("不同阶段各自成池，没有跨阶段的统一名次", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const met1 = await newPerson(s, user.id, { stage: "JUST_MET" });
    const met2 = await newPerson(s, user.id, { stage: "JUST_MET" });
    const know1 = await newPerson(s, user.id);
    const know2 = await newPerson(s, user.id);
    await saveAnalysis(user.id, met1.id, { levels: all("very_good") });
    await saveAnalysis(user.id, met2.id, { levels: all("weak") });
    await saveAnalysis(user.id, know1.id, { levels: all("fair") });
    await saveAnalysis(user.id, know2.id, { levels: all("good") });
    const o = await s.compare.overview(user.id);
    expect(o.comparison.pools.map((p) => p.stage)).toEqual(["JUST_MET", "GETTING_TO_KNOW"]);
    expect(pool(o, "JUST_MET")!.ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(pool(o)!.ranked.map((r) => [r.id, r.rank])).toEqual([[know2.id, 1], [know1.id, 2]]);
  });

  it("对方明确拒绝的对象不入池，也不影响其他人的排名", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const refused = await newPerson(s, user.id);
    const a = await newPerson(s, user.id);
    const b = await newPerson(s, user.id);
    await saveAnalysis(user.id, refused.id, { levels: all("very_good"), refusal: true });
    await saveAnalysis(user.id, a.id, { levels: all("good") });
    await saveAnalysis(user.id, b.id, { levels: all("fair") });
    const o = await s.compare.overview(user.id);
    expect(o.comparison.excluded).toContainEqual({ id: refused.id, reason: "EXPLICIT_REFUSAL" });
    expect(pool(o)!.ranked.map((r) => r.id)).toEqual([a.id, b.id]);
  });
});

describe("旧报告需先重新分析才能入池", () => {
  async function pair(s: S) {
    const user = await makeUser(ctx.db);
    const a = await newPerson(s, user.id);
    const b = await newPerson(s, user.id);
    await saveAnalysis(user.id, a.id, { levels: all("good") });
    await saveAnalysis(user.id, b.id, { levels: all("fair") });
    return { user, a, b };
  }

  it("修改偏好后，旧分析标“偏好变更待更新”并退出排名；用新偏好重新分析后回到排名", async () => {
    const s = services();
    const { user, a, b } = await pair(s);
    expect(pool(await s.compare.overview(user.id))!.ranked).toHaveLength(2);

    const saved = await s.preferences.save(user.id, { importance: { ...equal, [A]: 5 } });
    const stale = await s.compare.overview(user.id);
    expect(stale.preferenceVersion).toBe(saved.version);
    expect(stale.entries.map((e) => e.freshness)).toEqual(["PREFERENCE_CHANGED", "PREFERENCE_CHANGED"]);
    expect(stale.comparison.excluded.map((x) => x.reason)).toEqual(["STALE_REPORT", "STALE_REPORT"]);
    expect(stale.comparison.pools).toEqual([]);

    // 重新分析（新的一份快照记录了新的偏好版本）后回到排名；旧报告的分数仍按旧偏好，不被改写
    await saveAnalysis(user.id, a.id, { levels: all("good"), preferenceVersion: saved.version, importance: { ...equal, [A]: 5 }, at: new Date(Date.now() + 1000) });
    await saveAnalysis(user.id, b.id, { levels: all("fair"), preferenceVersion: saved.version, importance: { ...equal, [A]: 5 }, at: new Date(Date.now() + 1000) });
    expect(pool(await s.compare.overview(user.id))!.ranked.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("规则版本升级后，旧分析标“规则变更”并退出排名", async () => {
    const s = services();
    const { user } = await pair(s);
    const upgraded = services("v1-active");
    const o = await upgraded.compare.overview(user.id);
    expect(o.entries.map((e) => e.freshness)).toEqual(["RULES_CHANGED", "RULES_CHANGED"]);
    expect(o.comparison.pools).toEqual([]);
  });

  it("报告引用的资料已被删除/纠正（资料纠正已过期）的对象退出排名", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const a = await newPerson(s, user.id);
    const b = await newPerson(s, user.id);
    const c = await newPerson(s, user.id);
    for (const p of [a, b, c]) await saveAnalysis(user.id, p.id, { levels: all("good") });
    // 让 a 的快照引用一条已不存在的消息
    await ctx.db.analysis.updateMany({ where: { personId: a.id }, data: { snapshotRefs: [{ id: "不存在的消息", revision: 1, batchId: "x", dataKind: "CONTINUOUS", seq: 1, speaker: "SELF", type: "TEXT", occurredAt: null, timePrecision: "UNKNOWN" }] } });
    const o = await s.compare.overview(user.id);
    expect(o.entries.find((e) => e.personId === a.id)!.freshness).toBe("CORRECTED_EXPIRED");
    expect(o.comparison.excluded).toContainEqual({ id: a.id, reason: "STALE_REPORT" });
    expect(pool(o)!.ranked.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
  });
});

describe("待了解与偏好权重", () => {
  it("共同已知维度不足时只展示各自已知维度，不排名；个体已知太少的先进入待了解", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const full = await newPerson(s, user.id);
    const other = await newPerson(s, user.id);
    const thin = await newPerson(s, user.id);
    await saveAnalysis(user.id, full.id, { levels: all("good") });
    await saveAnalysis(user.id, other.id, { levels: { [A]: "good", [B]: "good", [C]: "good", [E]: "good" }, clue: [D] });
    await saveAnalysis(user.id, thin.id, { levels: { [A]: "very_good", [B]: "very_good" } });
    const g = pool(await s.compare.overview(user.id))!;
    expect(g.waiting).toContainEqual({ id: thin.id, reason: "FEW_KNOWN", known: [A, B] });
    expect(g.ranked.map((r) => r.id).sort()).toEqual([full.id, other.id].sort()); // 共同 A、B、C、E 四个
    expect(g.commonDimensions).toEqual([A, B, C, E]);
  });

  it("重要程度为 5 的维度必须已知：用当前偏好判断，缺少它的对象进入待了解", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const saved = await s.preferences.save(user.id, { importance: { ...equal, [D]: 5 } });
    const a = await newPerson(s, user.id);
    const b = await newPerson(s, user.id);
    const c = await newPerson(s, user.id);
    const imp = { ...equal, [D]: 5 };
    const at = { preferenceVersion: saved.version, importance: imp };
    await saveAnalysis(user.id, a.id, { levels: all("good"), ...at });
    await saveAnalysis(user.id, b.id, { levels: all("fair"), ...at });
    await saveAnalysis(user.id, c.id, { levels: { [A]: "very_good", [B]: "very_good", [C]: "very_good", [E]: "very_good" }, ...at }); // 4 个已知，但缺重要维度 D
    const g = pool(await s.compare.overview(user.id))!;
    expect(g.waiting).toEqual([{ id: c.id, reason: "MISSING_CRITICAL", known: [A, B, C, E] }]);
    expect(g.ranked.map((r) => r.id)).toEqual([a.id, b.id]);
    // 排名分数按用户权重加权：a 全是 75
    expect(g.ranked[0].score).toBe(75);
  });

  it("报告里的适配分按报告当时的偏好计算，只在五维全已知时出现", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    const imp = { ...equal, [A]: 5 };
    await saveAnalysis(user.id, p.id, { levels: { [A]: "very_good", [B]: "fair", [C]: "fair", [D]: "fair", [E]: "fair" }, importance: imp });
    const full = (await s.analysis.getReport(user.id, p.id)).latest!;
    expect(full.importance).toEqual(imp);
    expect(full.fit).toMatchObject({ kind: "scored", score: 64.7 }); // (5×100 + 3×50×4) / 17 = 64.70…
  });
});

describe("用户归属与确定性", () => {
  it("只看当前用户未被删除的对象；B 的总览里没有 A 的任何对象，也读不到 A 的趋势", async () => {
    const s = services();
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    const pa = await newPerson(s, a.id, { nickname: "A 的对象" });
    await saveAnalysis(a.id, pa.id);
    const gone = await newPerson(s, a.id, { nickname: "将被删除" });
    await saveAnalysis(a.id, gone.id);
    await s.people.remove(a.id, gone.id);

    expect((await s.compare.overview(a.id)).entries.map((e) => e.nickname)).toEqual(["A 的对象"]);
    expect(await s.compare.overview(b.id)).toMatchObject({ entries: [], comparison: { pools: [], excluded: [] } });
    await expect(s.compare.trend(b.id, pa.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("相同的已保存分析、规则与偏好得到相同的结果（重复计算不变）", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    for (const level of ["good", "fair", "weak"] as const) await saveAnalysis(user.id, (await newPerson(s, user.id)).id, { levels: all(level) });
    const first = await s.compare.overview(user.id);
    const second = await s.compare.overview(user.id);
    expect(second).toEqual(first);
  });
});

describe("趋势", () => {
  const t = (day: number) => new Date(Date.UTC(2026, 2, day));
  const withLevel = (level: Level, day: number, extra: Parameters<typeof saveAnalysis>[2] = {}) => ({ levels: all(level), at: t(day), ...extra });

  it("同规则同偏好的最近几份快照：分差 ≥ 8 才标上升/下降", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    await saveAnalysis(user.id, p.id, withLevel("fair", 1)); // 50
    expect((await s.compare.trend(user.id, p.id)).trend.kind).toBe("INSUFFICIENT"); // 只有一份
    await saveAnalysis(user.id, p.id, withLevel("good", 2)); // 75
    expect((await s.compare.trend(user.id, p.id)).trend).toMatchObject({ kind: "UP", delta: 25 });
    await saveAnalysis(user.id, p.id, withLevel("good", 3)); // 75
    expect((await s.compare.trend(user.id, p.id)).trend).toMatchObject({ kind: "UP", delta: 25 }); // 窗口 50→75→75
    const r = await s.compare.trend(user.id, p.id);
    expect(r.snapshotCount).toBe(3);
  });

  it("偏好变更后的新快照：分差是口径变化，不显示趋势", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    await saveAnalysis(user.id, p.id, withLevel("weak", 1, { preferenceVersion: 0 }));
    await saveAnalysis(user.id, p.id, withLevel("very_good", 2, { preferenceVersion: 1, importance: { ...equal, [A]: 5 } }));
    expect((await s.compare.trend(user.id, p.id)).trend).toEqual({ kind: "BASELINE_CHANGED", changed: ["preference"] });
  });

  it("未五维全已知的快照没有适配分，不参与趋势", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const p = await newPerson(s, user.id);
    await saveAnalysis(user.id, p.id, withLevel("fair", 1));
    await saveAnalysis(user.id, p.id, { levels: { [A]: "very_good", [B]: "very_good", [C]: "very_good", [D]: "very_good" }, at: t(2) }); // 缺 E
    expect((await s.compare.trend(user.id, p.id)).trend.kind).toBe("INSUFFICIENT");
  });
});
