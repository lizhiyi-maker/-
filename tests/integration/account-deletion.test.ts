import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { makePng } from "../support/png";
import { createAccount } from "@/server/account/service";
import { createAdmin } from "@/server/admin/service";
import { createAnalysis, type AnalysisJob } from "@/server/analysis/service";
import { createAuth } from "@/server/auth/service";
import { createConsent } from "@/server/consent/service";
import { createEvents } from "@/server/events/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { createRecognition } from "@/server/recognition/service";
import { createLocalStorage } from "@/server/storage/local";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import { createMockVision } from "@/server/ai/mock-vision";
import { NotFoundError, ValidationError } from "@/server/errors";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let dir: string;
beforeAll(async () => {
  ctx = await newTestDb();
  dir = mkdtempSync(join(tmpdir(), "rel-account-"));
});
afterAll(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

function env() {
  const jobs: AnalysisJob[] = [];
  const storage = createLocalStorage({ dir, secret: "test-storage-signing-secret-0123456789" });
  const quota = createQuota(ctx.db);
  const consent = createConsent(ctx.db, { providerId: "mock" });
  const preferences = createPreferences(ctx.db);
  const analysis = createAnalysis(ctx.db, { quota, consent, preferences, model: createMockAnalysisModel(), queue: { enqueue: async (j) => void jobs.push(j) } });
  return {
    jobs,
    storage,
    quota,
    consent,
    preferences,
    analysis,
    account: createAccount(ctx.db, { storage }),
    admin: createAdmin(ctx.db, { keys }),
    auth: createAuth(ctx.db, { sms: { send: async () => {} }, keys }),
    imports: createImports(ctx.db, { storage, quota }),
    people: createPeople(ctx.db, { quota }),
    events: createEvents(ctx.db),
    rec: createRecognition(ctx.db, { storage, quota, consent, vision: createMockVision(), queue: { enqueue: async () => {} } }),
  };
}
type E = ReturnType<typeof env>;

let seq = 0;
/** 一个有完整数据的用户：对象、聊天、事件、截图文件、偏好、额度、同意、会话。 */
async function fullUser(e: E, over: { role?: "USER" | "ADMIN" } = {}) {
  const user = await makeUser(ctx.db, { role: over.role });
  await e.consent.accept(user.id);
  await e.quota.getSummary(user.id);
  await e.preferences.save(user.id, { importance: { mutual_investment: 5, willingness_to_know: 3, follow_through: 3, communication_boundaries: 3, pace_alignment: 3 } });
  const token = await e.auth.createSession(user.id);
  const person = await e.people.create(user.id, { nickname: `阿青${seq++}` });
  await e.people.setFeeling(user.id, person.id, "STRONG");
  const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" });
  await e.imports.submitText(user.id, batch.id, "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班");
  await e.imports.setLabelRole(user.id, batch.id, "阿青", "OTHER");
  await e.imports.setLabelRole(user.id, batch.id, "我", "SELF");
  await e.imports.confirm(user.id, batch.id);
  await e.events.create(user.id, person.id, { kind: "MEET", occurredOn: "2026-03-03", facts: "见面" });
  const shotBatch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
  const added = await e.rec.addScreenshot(user.id, shotBatch.id, { name: "a.png", bytes: makePng("阿青：你好") });
  if (added.status !== "added") throw new Error("应当添加成功");
  const shot = await ctx.db.screenshot.findUniqueOrThrow({ where: { id: added.id } });
  return { user, token, person, storageKey: shot.storageKey };
}

const counts = async (userId: string) => ({
  user: await ctx.db.user.count({ where: { id: userId } }),
  sessions: await ctx.db.session.count({ where: { userId } }),
  people: await ctx.db.person.count({ where: { userId } }),
  batches: await ctx.db.importBatch.count({ where: { userId } }),
  messages: await ctx.db.message.count({ where: { userId } }),
  screenshots: await ctx.db.screenshot.count({ where: { userId } }),
  events: await ctx.db.offlineEvent.count({ where: { userId } }),
  analyses: await ctx.db.analysis.count({ where: { userId } }),
  preference: await ctx.db.preference.count({ where: { userId } }),
  quota: await ctx.db.quotaEntry.count({ where: { userId } }),
  consents: await ctx.db.consentRecord.count({ where: { userId } }),
  feelings: await ctx.db.feelingEntry.count({ where: { userId } }),
});

describe("立即停用", () => {
  it("开始删除后：账户置为“删除中”，已有会话立即失效，不能再用验证码登录；数据此时仍在，等待第二步", async () => {
    const e = env();
    const { user, token } = await fullUser(e);
    expect(await e.auth.getSessionUser(token)).not.toBeNull();
    await e.account.begin(user.id);

    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("DELETING");
    expect(await e.auth.getSessionUser(token)).toBeNull();
    expect(await ctx.db.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await counts(user.id)).messages).toBeGreaterThan(0);
  });

  it("“删除中”的账户不能登录：即使验证码正确，提示账户正在删除", async () => {
    const e = env();
    const sent: string[] = [];
    let now = new Date("2026-03-01T08:00:00Z");
    const auth = createAuth(ctx.db, { sms: { send: async (_p, code) => void sent.push(code) }, keys, now: () => now });
    const phone = "13900001111";
    await auth.requestLoginCode(phone, "9.9.9.1");
    await ctx.db.inviteCode.create({ data: { code: "DELACCT01", maxUses: 5, expiresAt: new Date("2030-01-01") } });
    const first = await auth.verifyLoginCode({ phone, code: sent.at(-1)!, inviteCode: "DELACCT01", ip: "9.9.9.1" });
    await e.account.begin(first.userId);
    now = new Date(now.getTime() + 120_000); // 过了重发间隔
    await auth.requestLoginCode(phone, "9.9.9.1");
    await expect(auth.verifyLoginCode({ phone, code: sent.at(-1)!, ip: "9.9.9.1" })).rejects.toMatchObject({ name: "AuthError", message: expect.stringContaining("删除") });
  });

  it("管理员也不能把“删除中”的用户恢复", async () => {
    const e = env();
    const admin = await makeUser(ctx.db, { role: "ADMIN" });
    const { user } = await fullUser(e);
    await e.account.begin(user.id);
    await expect(e.admin.setUserStatus(admin.id, user.id, "ACTIVE")).rejects.toBeInstanceOf(ValidationError);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("DELETING");
  });
});

describe("删除全部在线数据", () => {
  it("完成后：账户与全部派生数据、会话、偏好、额度流水、同意记录、原图文件都被删除", async () => {
    const e = env();
    const { user, storageKey } = await fullUser(e);
    expect(await e.storage.get(storageKey)).not.toBeNull();
    expect(await counts(user.id)).toMatchObject({ user: 1, people: 1, events: 1, preference: 1, consents: 1, feelings: 1 });

    await e.account.deleteAccount(user.id);

    expect(await counts(user.id)).toEqual({ user: 0, sessions: 0, people: 0, batches: 0, messages: 0, screenshots: 0, events: 0, analyses: 0, preference: 0, quota: 0, consents: 0, feelings: 0 });
    expect(await ctx.db.messageRevision.count({ where: { message: { userId: user.id } } })).toBe(0);
    expect(await e.storage.get(storageKey)).toBeNull();
  });

  it("其他用户不受影响：数据、文件、会话都在", async () => {
    const e = env();
    const a = await fullUser(e);
    const b = await fullUser(e);
    const before = await counts(b.user.id);
    await e.account.deleteAccount(a.user.id);
    expect(await counts(b.user.id)).toEqual(before);
    expect(await e.storage.get(b.storageKey)).not.toBeNull();
    expect(await e.auth.getSessionUser(b.token)).not.toBeNull();
  });

  it("进行中的分析：删除后迟到的任务不能写回，也不会报错；额度随账户一起删除", async () => {
    const e = env();
    const { user, person } = await fullUser(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    await e.account.deleteAccount(user.id);
    await e.analysis.process(e.jobs.shift()!); // 迟到的任务
    expect(await ctx.db.analysis.count({ where: { id: analysisId } })).toBe(0);
    expect(await ctx.db.quotaEntry.count({ where: { userId: user.id } })).toBe(0);
  });

  it("分析进行中删除账户：结果被丢弃，不写回", async () => {
    const e = env();
    const { user, person } = await fullUser(e);
    const { analysisId } = await e.analysis.start(user.id, person.id);
    const base = createMockAnalysisModel();
    const racing = createAnalysis(ctx.db, {
      quota: e.quota,
      consent: e.consent,
      preferences: e.preferences,
      model: { ...base, async interpret(input) { await e.account.deleteAccount(user.id); return base.interpret(input); } },
      queue: { enqueue: async () => {} },
    });
    await racing.process(e.jobs.shift()!);
    expect(await ctx.db.analysis.count({ where: { id: analysisId } })).toBe(0);
    expect(await counts(user.id)).toMatchObject({ user: 0, people: 0, messages: 0 });
  });

  it("同一个人再次用这个手机号注册是全新的账户，看不到任何旧数据", async () => {
    const e = env();
    const { user } = await fullUser(e);
    const phoneHash = (await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).phoneHash;
    await e.account.deleteAccount(user.id);
    expect(await ctx.db.user.count({ where: { phoneHash } })).toBe(0);
  });
});

describe("可重入与清扫", () => {
  it("中途停在“删除中”（第二步没有完成）：worker 的清扫任务继续完成，只处理“删除中”的账户", async () => {
    const e = env();
    await e.account.sweepDeleting(); // 先清掉前面用例留下的“删除中”账户（同一个数据库）
    const gone = await fullUser(e);
    const alsoGone = await fullUser(e);
    const normal = await fullUser(e);
    await e.account.begin(gone.user.id);
    await e.account.begin(alsoGone.user.id);

    expect(await e.account.sweepDeleting()).toBe(2);
    expect(await counts(gone.user.id)).toMatchObject({ user: 0, people: 0, messages: 0 });
    expect(await counts(alsoGone.user.id)).toMatchObject({ user: 0 });
    expect(await counts(normal.user.id)).toMatchObject({ user: 1, people: 1 });
    expect(await e.storage.get(gone.storageKey)).toBeNull();
    expect(await e.account.sweepDeleting()).toBe(0);
  });

  it("重复请求是安全的：删除中再次开始不报错；已经删除的账户再次开始是“不存在”", async () => {
    const e = env();
    const { user } = await fullUser(e);
    await e.account.begin(user.id);
    await e.account.begin(user.id);
    await e.account.complete(user.id);
    await e.account.complete(user.id); // 已完成：什么都不做
    await expect(e.account.begin(user.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await ctx.db.auditLog.count({ where: { actorId: user.id, action: "account.delete.start" } })).toBe(1);
  });

  it("没有开始删除的账户不能直接“完成”（防止误删）", async () => {
    const e = env();
    const { user } = await fullUser(e);
    await expect(e.account.complete(user.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await counts(user.id)).people).toBe(1);
  });
});

describe("管理员与审计", () => {
  it("唯一的启用管理员不能删除自己，账户与数据原样保留", async () => {
    const e = env();
    // 先停用其他所有管理员，保证这是唯一的启用管理员
    await ctx.db.user.updateMany({ where: { role: "ADMIN" }, data: { status: "SUSPENDED" } });
    const { user } = await fullUser(e, { role: "ADMIN" });
    await expect(e.account.deleteAccount(user.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ACTIVE");
    expect((await counts(user.id)).people).toBe(1);
  });

  it("还有另一位启用的管理员时，管理员可以删除自己的账户", async () => {
    const e = env();
    await makeUser(ctx.db, { role: "ADMIN" });
    const { user } = await fullUser(e, { role: "ADMIN" });
    await e.account.deleteAccount(user.id);
    expect((await counts(user.id)).user).toBe(0);
  });

  it("审计只留开始与完成两条，含用户 ID 和对象数量，不含手机号、聊天或昵称", async () => {
    const e = env();
    const { user, person } = await fullUser(e);
    const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
    await e.account.deleteAccount(user.id);
    const logs = await ctx.db.auditLog.findMany({ where: { actorId: user.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["account.delete.start", "account.delete.complete"]);
    expect(logs[1].meta).toEqual({ people: 1 });
    const json = JSON.stringify(logs);
    for (const secret of [row.phoneHash, row.phoneEnc, person.nickname, "加班", "最近在忙什么"]) expect(json).not.toContain(secret);
  });
});
