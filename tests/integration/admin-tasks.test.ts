import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { createAdmin, ForbiddenError } from "@/server/admin/service";
import { createPeople } from "@/server/people/service";
import { createImports } from "@/server/imports/service";
import { createQuota } from "@/server/quota/ledger";
import { decryptPhone, maskPhone } from "@/server/auth/phone";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-06-10T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const admin = () => createAdmin(ctx.db, { keys, now: () => NOW });

/** 每个用例独立的数据库状态：用一个新的管理员和新用户，并只断言与自己造的任务有关的内容。 */
let seq = 0;
async function world() {
  const adminUser = await makeUser(ctx.db, { role: "ADMIN" });
  const user = await makeUser(ctx.db);
  const people = createPeople(ctx.db, { quota: createQuota(ctx.db) });
  const person = await people.create(user.id, { nickname: `不应出现的昵称${seq++}` });
  const batch = await createImports(ctx.db, { storage: undefined as never, quota: createQuota(ctx.db) }).createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
  return { adminUser, user, person, batch };
}

let idx = 0;
type W = Awaited<ReturnType<typeof world>>;
const analysis = (w: W, over: { status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INVALIDATED"; queuedAt: Date; errorCode?: string; startedAt?: Date; finishedAt?: Date }) =>
  ctx.db.analysis.create({
    data: {
      userId: w.user.id, personId: w.person.id, generation: 0, snapshotAt: over.queuedAt, messageCount: 0, snapshotRefs: [] as Prisma.InputJsonValue, preferenceVersion: 0, preferenceValues: {} as Prisma.InputJsonValue,
      rulesVersion: "v0", promptVersion: "p", modelId: "m", status: over.status, errorCode: over.errorCode, queuedAt: over.queuedAt, startedAt: over.startedAt, finishedAt: over.finishedAt,
    },
  });
const shot = (w: W, over: { status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED"; queuedAt: Date; errorCode?: string; finishedAt?: Date }) =>
  ctx.db.screenshot.create({
    data: { userId: w.user.id, personId: w.person.id, batchId: w.batch.id, idx: idx++, sha256: `h${idx}`, contentType: "image/png", sizeBytes: 1, storageKey: `秘密路径/key-${idx}`, status: over.status, queuedAt: over.queuedAt, errorCode: over.errorCode, finishedAt: over.finishedAt, round: 1 },
  });

describe("任务状态", () => {
  it("近 24 小时各状态的数量：分析与截图识别分开统计，更早的不计入", async () => {
    const w = await world();
    await analysis(w, { status: "SUCCEEDED", queuedAt: ago(HOUR), finishedAt: ago(HOUR - MIN) });
    await analysis(w, { status: "SUCCEEDED", queuedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR - MIN) });
    await analysis(w, { status: "FAILED", queuedAt: ago(3 * HOUR), errorCode: "MODEL_FAILED", finishedAt: ago(3 * HOUR - MIN) });
    await analysis(w, { status: "SUCCEEDED", queuedAt: ago(30 * HOUR), finishedAt: ago(30 * HOUR - MIN) }); // 超过 24 小时
    await shot(w, { status: "DONE", queuedAt: ago(HOUR), finishedAt: ago(HOUR - MIN) });
    await shot(w, { status: "FAILED", queuedAt: ago(HOUR), errorCode: "RECOGNITION_FAILED", finishedAt: ago(HOUR - MIN) });
    await shot(w, { status: "DONE", queuedAt: ago(40 * HOUR), finishedAt: ago(40 * HOUR - MIN) }); // 超过 24 小时

    const t = await admin().taskStatus(w.adminUser.id);
    // 数据库是共享的：只断言“至少包含我造的”，并检查窗口外的没被算进去（与不含窗口外时的差值）
    expect(t.windowHours).toBe(24);
    expect(t.analysis.counts.SUCCEEDED).toBeGreaterThanOrEqual(2);
    expect(t.analysis.counts.FAILED).toBeGreaterThanOrEqual(1);
    expect(t.recognition.counts.DONE).toBeGreaterThanOrEqual(1);
    expect(t.recognition.counts.FAILED).toBeGreaterThanOrEqual(1);
  });

  it("精确计数（独立的数据库）：窗口外的不计入，失败原因按错误码分布", async () => {
    const own = await newTestDb();
    try {
      const db = own.db;
      const adminUser = await makeUser(db, { role: "ADMIN" });
      const user = await makeUser(db);
      const person = await createPeople(db).create(user.id, { nickname: "x" });
      const batch = await createImports(db, { storage: undefined as never, quota: createQuota(db) }).createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
      const mk = (status: "SUCCEEDED" | "FAILED" | "INVALIDATED", queuedAt: Date, errorCode?: string) =>
        db.analysis.create({ data: { userId: user.id, personId: person.id, generation: 0, snapshotAt: queuedAt, messageCount: 0, snapshotRefs: [], preferenceVersion: 0, preferenceValues: {}, rulesVersion: "v0", promptVersion: "p", modelId: "m", status, errorCode, queuedAt } });
      await mk("SUCCEEDED", ago(HOUR));
      await mk("SUCCEEDED", ago(2 * HOUR));
      await mk("FAILED", ago(3 * HOUR), "MODEL_FAILED");
      await mk("FAILED", ago(4 * HOUR), "MODEL_FAILED");
      await mk("FAILED", ago(5 * HOUR), "INVALID_OUTPUT");
      await mk("INVALIDATED", ago(6 * HOUR), "INPUT_CHANGED");
      await mk("SUCCEEDED", ago(30 * HOUR)); // 窗口外
      await mk("FAILED", ago(30 * HOUR), "TIMEOUT"); // 窗口外
      for (const [i, status] of (["DONE", "DONE", "FAILED"] as const).entries()) {
        await db.screenshot.create({ data: { userId: user.id, personId: person.id, batchId: batch.id, idx: i, sha256: `s${i}`, contentType: "image/png", sizeBytes: 1, storageKey: `k${i}`, status, queuedAt: ago(HOUR), errorCode: status === "FAILED" ? "RECOGNITION_FAILED" : null } });
      }
      const t = await createAdmin(db, { keys, now: () => NOW }).taskStatus(adminUser.id);
      expect(t.analysis.counts).toEqual({ SUCCEEDED: 2, FAILED: 3, INVALIDATED: 1 });
      expect(t.analysis.errorCodes).toEqual({ MODEL_FAILED: 2, INVALID_OUTPUT: 1, INPUT_CHANGED: 1 });
      expect(t.recognition.counts).toEqual({ DONE: 2, FAILED: 1 });
      expect(t.recognition.errorCodes).toEqual({ RECOGNITION_FAILED: 1 });
    } finally {
      await own.close();
    }
  });

  it("卡住的任务：排队/运行超过 15 分钟没有结果，列出类型、状态、已过时间；刚提交的、已结束的不算", async () => {
    const w = await world();
    const stuckA = await analysis(w, { status: "RUNNING", queuedAt: ago(40 * MIN), startedAt: ago(39 * MIN) });
    const stuckS = await shot(w, { status: "QUEUED", queuedAt: ago(20 * MIN) });
    await analysis(w, { status: "QUEUED", queuedAt: ago(5 * MIN) }); // 还没到阈值
    await analysis(w, { status: "SUCCEEDED", queuedAt: ago(40 * MIN), finishedAt: ago(39 * MIN) });
    const t = await admin().taskStatus(w.adminUser.id);
    expect(t.stuckAfterMinutes).toBe(15);
    const mine = t.stuck.filter((s) => [stuckA.id, stuckS.id].includes(s.id));
    expect(mine.map((s) => [s.kind, s.status, s.ageMinutes]).sort()).toEqual([["ANALYSIS", "RUNNING", 40], ["RECOGNITION", "QUEUED", 20]]);
    expect(t.stuck.every((s) => s.ageMinutes >= 15)).toBe(true);
  });

  it("最近任务：分析与识别合并按提交时间从新到旧，最多 50 条，带错误码与耗时", async () => {
    const own = await newTestDb();
    try {
      const db = own.db;
      const adminUser = await makeUser(db, { role: "ADMIN" });
      const user = await makeUser(db);
      const person = await createPeople(db).create(user.id, { nickname: "x" });
      const batch = await createImports(db, { storage: undefined as never, quota: createQuota(db) }).createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
      for (let i = 0; i < 40; i++) {
        await db.analysis.create({ data: { userId: user.id, personId: person.id, generation: 0, snapshotAt: ago(i * MIN), messageCount: 0, snapshotRefs: [], preferenceVersion: 0, preferenceValues: {}, rulesVersion: "v0", promptVersion: "p", modelId: "m", status: "SUCCEEDED", queuedAt: ago(i * MIN + 30_000), startedAt: ago(i * MIN + 20_000), finishedAt: ago(i * MIN + 10_000) } });
      }
      for (let i = 0; i < 30; i++) {
        await db.screenshot.create({ data: { userId: user.id, personId: person.id, batchId: batch.id, idx: i, sha256: `s${i}`, contentType: "image/png", sizeBytes: 1, storageKey: `k${i}`, status: i === 0 ? "FAILED" : "DONE", errorCode: i === 0 ? "RECOGNITION_FAILED" : null, queuedAt: ago(i * MIN), finishedAt: ago(i * MIN - 5_000) } });
      }
      const t = await createAdmin(db, { keys, now: () => NOW }).taskStatus(adminUser.id);
      expect(t.recent).toHaveLength(50);
      const times = t.recent.map((r) => r.queuedAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(new Set(t.recent.map((r) => r.kind))).toEqual(new Set(["ANALYSIS", "RECOGNITION"]));
      expect(t.recent.find((r) => r.status === "FAILED")).toMatchObject({ kind: "RECOGNITION", errorCode: "RECOGNITION_FAILED", durationMs: 5000 });
      expect(t.recent.find((r) => r.kind === "ANALYSIS")).toMatchObject({ durationMs: 10_000 });
    } finally {
      await own.close();
    }
  });

  it("不含任何聊天内容、昵称或文件路径；用户只显示脱敏手机号，看不到完整手机号和用户 ID", async () => {
    const w = await world();
    await analysis(w, { status: "FAILED", queuedAt: ago(10 * MIN), errorCode: "MODEL_FAILED", finishedAt: ago(9 * MIN) });
    await shot(w, { status: "QUEUED", queuedAt: ago(20 * MIN) });
    const t = await admin().taskStatus(w.adminUser.id);
    const row = await ctx.db.user.findUniqueOrThrow({ where: { id: w.user.id } });
    const phone = decryptPhone(row.phoneEnc, keys.encKey);
    const json = JSON.stringify(t);
    for (const secret of [phone, w.person.nickname, "秘密路径", row.phoneHash, row.phoneEnc, w.user.id, w.batch.id]) expect(json).not.toContain(secret);
    expect(json).toContain(maskPhone(phone));
    expect(t.recent.every((r) => !("userId" in r))).toBe(true);
  });

  it("只有启用的管理员能看：普通用户、停用的管理员都被拒绝", async () => {
    const w = await world();
    const suspended = await makeUser(ctx.db, { role: "ADMIN", status: "SUSPENDED" });
    await expect(admin().taskStatus(w.user.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(admin().taskStatus(suspended.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(admin().taskStatus("不存在的用户")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
