import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createConsent } from "@/server/consent/service";
import { createEvents } from "@/server/events/service";
import { createExport, EXPORT_FORMAT } from "@/server/export/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { NotFoundError } from "@/server/errors";
import { DIMENSION_KEYS } from "@/domain/analysis/rules";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

function services() {
  const quota = createQuota(ctx.db);
  return {
    quota,
    exporter: createExport(ctx.db),
    imports: createImports(ctx.db, { quota }),
    people: createPeople(ctx.db, { quota }),
    events: createEvents(ctx.db),
    preferences: createPreferences(ctx.db),
    consent: createConsent(ctx.db, { providerId: "mock" }),
  };
}
type S = ReturnType<typeof services>;

const CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班\n[2026-03-02 20:00] 阿青：周末有什么打算吗？";

let seq = 0;
async function saveChat(s: S, userId: string, personId: string, text = CHAT) {
  const batch = await s.imports.createBatch(userId, personId, { platform: "WECHAT", dataKind: "CONTINUOUS" });
  await s.imports.submitText(userId, batch.id, text);
  await s.imports.setLabelRole(userId, batch.id, "阿青", "OTHER");
  await s.imports.setLabelRole(userId, batch.id, "我", "SELF");
  await s.imports.confirm(userId, batch.id);
  return batch.id;
}
async function saveAnalysis(userId: string, personId: string, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, { status: "known", level: "good", observedFacts: [], interpretations: [], supporting: [], counter: [], missing: [], userExperience: [] }]));
  return ctx.db.analysis.create({
    data: {
      userId, personId, status, generation: 0, snapshotAt: new Date("2026-03-05T00:00:00Z"), messageCount: 3, snapshotRefs: [] as Prisma.InputJsonValue,
      preferenceVersion: 0, preferenceValues: { importance: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 3])) } as Prisma.InputJsonValue,
      rulesVersion: "v0-experimental", promptVersion: "p", modelId: "m",
      output: { conclusion: { summary: "测试结论" }, dimensions, explicitRefusal: { detected: false, refs: [] }, suggestions: [] } as unknown as Prisma.InputJsonValue,
      queuedAt: new Date(), finishedAt: new Date(),
    },
  });
}

/** 一个有完整数据的用户。 */
async function fullUser(s: S) {
  const user = await makeUser(ctx.db);
  await s.consent.accept(user.id);
  await s.quota.getSummary(user.id); // 额度在首次访问时发放
  await s.preferences.save(user.id, { importance: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, k === DIMENSION_KEYS[0] ? 5 : 3])) });
  const person = await s.people.create(user.id, { nickname: `阿青${seq++}`, gender: "FEMALE", stage: "GETTING_TO_KNOW", feelingsNote: "我的私人感受备注", channel: "朋友介绍" });
  await s.people.addAccount(user.id, person.id, { platform: "WECHAT", handle: "aqing_wx" });
  await s.people.setFeeling(user.id, person.id, "UNSURE");
  await s.people.setFeeling(user.id, person.id, "STRONG");
  await saveChat(s, user.id, person.id);
  const ev = await s.events.create(user.id, person.id, { kind: "MEET", occurredOn: "2026-03-03", facts: "在咖啡店见面", personalNote: "我的事件感受" });
  await s.events.update(user.id, ev.id, { facts: "在咖啡店见面，聊了两小时" });
  await saveAnalysis(user.id, person.id);
  return { user, person, event: ev };
}

describe("数据导出", () => {
  it("覆盖用户自己的全部结构化资料：对象、账号、好感历史、事件（事实修订与个人感受）、消息与修订、报告与适配分、偏好、同意、额度流水", async () => {
    const s = services();
    const { user, person } = await fullUser(s);
    const out = await s.exporter.build(user.id);

    expect(out).toMatchObject({ format: EXPORT_FORMAT, version: 1 });
    expect(out.preferences).toMatchObject({ version: 1 });
    expect(out.consents).toEqual([expect.objectContaining({ version: 1, providerId: "mock" })]);
    expect(out.quotaLedger.length).toBeGreaterThan(0);

    expect(out.people).toHaveLength(1);
    const p = out.people[0];
    expect(p).toMatchObject({ id: person.id, nickname: person.nickname, gender: "FEMALE", stage: "GETTING_TO_KNOW", channel: "朋友介绍", feelingsNote: "我的私人感受备注" });
    expect(p.platformAccounts).toEqual([expect.objectContaining({ platform: "WECHAT", handle: "aqing_wx" })]);
    expect(p.feelingHistory.map((f) => f.value)).toEqual(["UNSURE", "STRONG"]);

    expect(p.batches).toHaveLength(1);
    expect(p.batches[0].messages.map((m) => [m.speaker, m.revisions.at(-1)!.content])).toEqual([["OTHER", "最近在忙什么？"], ["SELF", "加班"], ["OTHER", "周末有什么打算吗？"]]);

    expect(p.offlineEvents).toHaveLength(1);
    expect(p.offlineEvents[0]).toMatchObject({ kind: "MEET", occurredOn: "2026-03-03", personalNote: "我的事件感受", currentRevision: 2 });
    expect(p.offlineEvents[0].factRevisions.map((r) => r.facts)).toEqual(["在咖啡店见面", "在咖啡店见面，聊了两小时"]); // 旧修订也在

    expect(p.analyses).toHaveLength(1);
    expect(p.analyses[0]).toMatchObject({ rulesVersion: "v0-experimental", fitScore: { kind: "scored", score: 75 }, report: { conclusion: { summary: "测试结论" } } });
  });

  it("消息的全部修订都导出：用户纠正过的消息，旧文字与当前文字都在；聊天文本用当前文字", async () => {
    const s = services();
    const { user, person } = await fullUser(s);
    const msg = (await ctx.db.message.findMany({ where: { personId: person.id }, include: { revisions: true } })).find((m) => m.revisions[0].content === "加班")!;
    await s.imports.editMessage(user.id, msg.id, { content: "刚下班" });
    const out = await s.exporter.build(user.id);
    const m = out.people[0].batches[0].messages.find((x) => x.id === msg.id)!;
    expect(m).toMatchObject({ currentRevision: 2 });
    expect(m.revisions.map((r) => r.content)).toEqual(["加班", "刚下班"]);
    expect(out.people[0].chatText).toContain("我：刚下班");
    expect(out.people[0].chatText).not.toContain("我：加班");
  });

  it("只导出已确认保存的消息：暂存中的批次不在导出里；失败的分析也不在", async () => {
    const s = services();
    const { user, person } = await fullUser(s);
    const staged = await s.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" });
    await s.imports.submitText(user.id, staged.id, "阿青：这是还没保存的暂存内容");
    await saveAnalysis(user.id, person.id, "FAILED");
    const out = await s.exporter.build(user.id);
    expect(JSON.stringify(out)).not.toContain("暂存内容");
    expect(out.people[0].batches).toHaveLength(1);
    expect(out.people[0].analyses).toHaveLength(1);
  });

  it("不含手机号（明文、哈希、密文）、会话令牌、验证码、存储路径和其他用户的任何数据", async () => {
    const s = services();
    const a = await fullUser(s);
    const b = await fullUser(s);
    const secretUser = await ctx.db.user.findUniqueOrThrow({ where: { id: a.user.id } });
    await ctx.db.session.create({ data: { userId: a.user.id, tokenHash: "token-hash-secret-value", expiresAt: new Date(Date.now() + 1e6) } });
    await ctx.db.loginCode.create({ data: { phoneHash: secretUser.phoneHash, codeHash: "code-hash-secret-value", expiresAt: new Date(Date.now() + 1e6) } });
    await ctx.db.screenshot.create({ data: { userId: a.user.id, personId: a.person.id, batchId: (await ctx.db.importBatch.findFirstOrThrow({ where: { personId: a.person.id } })).id, idx: 99, sha256: "x", contentType: "image/png", sizeBytes: 1, storageKey: "secret/storage/key-path" } });

    const json = JSON.stringify(await s.exporter.build(a.user.id));
    for (const secret of [secretUser.phoneHash, secretUser.phoneEnc, "token-hash-secret-value", "code-hash-secret-value", "secret/storage/key-path", b.person.nickname, b.user.id]) {
      expect(json).not.toContain(secret);
    }
    // 对照：B 的导出里是 B 自己的数据，没有 A 的
    const jsonB = JSON.stringify(await s.exporter.build(b.user.id));
    expect(jsonB).toContain(b.person.nickname);
    expect(jsonB).not.toContain(a.person.nickname);
    expect(jsonB).not.toContain(a.user.id);
  });

  it("没有任何数据的新用户：导出是空的结构，不报错", async () => {
    const s = services();
    const user = await makeUser(ctx.db);
    const out = await s.exporter.build(user.id);
    expect(out).toMatchObject({ preferences: null, consents: [], people: [] });
  });

  it("单个对象的聊天文本：可读格式；别人的对象与不存在的表现一致", async () => {
    const s = services();
    const { user, person } = await fullUser(s);
    const other = await makeUser(ctx.db);
    const { text, nickname } = await s.exporter.chatText(user.id, person.id);
    expect(nickname).toBe(person.nickname);
    expect(text).toContain("[2026-03-01 20:00] 对方：最近在忙什么？");
    expect(text).toContain("[2026-03-01 20:02] 我：加班");
    await expect(s.exporter.chatText(other.id, person.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.exporter.chatText(user.id, "不存在")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("导出行为写审计，只记录数量，不含任何内容", async () => {
    const s = services();
    const { user } = await fullUser(s);
    await s.exporter.build(user.id);
    const logs = await ctx.db.auditLog.findMany({ where: { actorId: user.id, action: "export.download" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).toEqual({ people: 1 });
    expect(JSON.stringify(logs)).not.toContain("加班");
  });
});
