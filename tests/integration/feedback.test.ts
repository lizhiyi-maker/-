import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { createAccount } from "@/server/account/service";
import { createAdmin, ForbiddenError } from "@/server/admin/service";
import { createExport } from "@/server/export/service";
import { createFeedback } from "@/server/feedback/service";
import { createPeople } from "@/server/people/service";
import { createLocalStorage } from "@/server/storage/local";
import { NotFoundError, ValidationError } from "@/server/errors";
import { decryptPhone, maskPhone } from "@/server/auth/phone";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let dir: string;
beforeAll(async () => {
  ctx = await newTestDb();
  dir = mkdtempSync(join(tmpdir(), "rel-feedback-"));
});
afterAll(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

let now = new Date("2026-06-10T12:00:00Z");
const feedback = () => createFeedback(ctx.db, { now: () => now });
const admin = () => createAdmin(ctx.db, { keys, now: () => now });

describe("提交反馈", () => {
  it("类型 + 文字，可选片段；片段只有用户填写才有，系统不附带任何其他信息", async () => {
    const user = await makeUser(ctx.db);
    const a = await feedback().submit(user.id, { category: "BUG", message: "  报告页打不开  " });
    const b = await feedback().submit(user.id, { category: "INACCURATE", message: "这句分析不对", snippet: "  用户自己粘贴的那一句  " });
    const rows = await ctx.db.feedback.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ category: "BUG", message: "报告页打不开", snippet: null, status: "NEW" });
    expect(rows[1]).toMatchObject({ category: "INACCURATE", snippet: "用户自己粘贴的那一句" });
    // 表里只有用户写下的内容：没有对象、聊天、报告的关联字段
    expect(Object.keys(rows[0]).sort()).toEqual(["category", "createdAt", "handledAt", "handledBy", "id", "message", "snippet", "status", "userId"]);
  });

  it("空片段存为空；内容必填；长度与类型校验，无效时什么都不保存", async () => {
    const user = await makeUser(ctx.db);
    await feedback().submit(user.id, { category: "OTHER", message: "x", snippet: "   " });
    expect((await ctx.db.feedback.findFirstOrThrow({ where: { userId: user.id } })).snippet).toBeNull();

    const bad = [
      { category: "BUG", message: "   " },
      { category: "BUG", message: "字".repeat(1001) },
      { category: "BUG", message: "x", snippet: "字".repeat(2001) },
      { category: "不存在", message: "x" },
    ];
    for (const input of bad) await expect(feedback().submit(user.id, input as never)).rejects.toBeInstanceOf(ValidationError);
    expect(await ctx.db.feedback.count({ where: { userId: user.id } })).toBe(1);
  });

  it("防刷：每人每 24 小时最多 10 条，超过后被拒绝；过了 24 小时可以再提交；别人不受影响", async () => {
    const user = await makeUser(ctx.db);
    const other = await makeUser(ctx.db);
    for (let i = 0; i < 10; i++) await feedback().submit(user.id, { category: "OTHER", message: `第${i}条` });
    await expect(feedback().submit(user.id, { category: "OTHER", message: "第 11 条" })).rejects.toBeInstanceOf(ValidationError);
    await expect(feedback().submit(other.id, { category: "OTHER", message: "别人" })).resolves.toBeDefined();
    now = new Date(now.getTime() + 25 * 3600_000);
    await expect(feedback().submit(user.id, { category: "OTHER", message: "第二天" })).resolves.toBeDefined();
  });

  it("我提交过的反馈只有自己看得到，从新到旧", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    await feedback().submit(a.id, { category: "BUG", message: "A 的第一条" });
    now = new Date(now.getTime() + 1000);
    await feedback().submit(a.id, { category: "BUG", message: "A 的第二条" });
    await feedback().submit(b.id, { category: "BUG", message: "B 的" });
    expect((await feedback().mine(a.id)).map((f) => f.message)).toEqual(["A 的第二条", "A 的第一条"]);
    expect((await feedback().mine(b.id)).map((f) => f.message)).toEqual(["B 的"]);
  });
});

describe("管理员查看与处理", () => {
  it("列表手机号脱敏、含片段；未处理的在前；普通用户、停用的管理员被拒绝", async () => {
    const adminUser = await makeUser(ctx.db, { role: "ADMIN" });
    const user = await makeUser(ctx.db);
    const suspended = await makeUser(ctx.db, { role: "ADMIN", status: "SUSPENDED" });
    const f = await feedback().submit(user.id, { category: "SUGGESTION", message: "希望能导出报告", snippet: "用户主动附上的片段" });

    const list = await admin().listFeedback(adminUser.id);
    const item = list.find((x) => x.id === f.id)!;
    const phone = decryptPhone((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).phoneEnc, keys.encKey);
    expect(item).toMatchObject({ category: "SUGGESTION", message: "希望能导出报告", snippet: "用户主动附上的片段", status: "NEW", userPhoneMasked: maskPhone(phone) });
    const json = JSON.stringify(list);
    expect(json).not.toContain(phone);
    expect(json).not.toContain(user.id);

    await expect(admin().listFeedback(user.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(admin().listFeedback(suspended.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(admin().handleFeedback(user.id, f.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("标记已处理：记录处理人与时间并写审计（审计不含反馈内容）；重复处理与不存在的反馈都是“不存在”", async () => {
    const adminUser = await makeUser(ctx.db, { role: "ADMIN" });
    const user = await makeUser(ctx.db);
    const f = await feedback().submit(user.id, { category: "BUG", message: "审计里不应出现这句话" });
    await admin().handleFeedback(adminUser.id, f.id);

    const row = await ctx.db.feedback.findUniqueOrThrow({ where: { id: f.id } });
    expect(row).toMatchObject({ status: "HANDLED", handledBy: adminUser.id });
    expect(row.handledAt).toBeInstanceOf(Date);
    const logs = await ctx.db.auditLog.findMany({ where: { actorId: adminUser.id, action: "feedback.handle", targetId: f.id } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("审计里不应出现");
    expect((await feedback().mine(user.id))[0].status).toBe("HANDLED");

    await expect(admin().handleFeedback(adminUser.id, f.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(admin().handleFeedback(adminUser.id, "不存在")).rejects.toBeInstanceOf(NotFoundError);
    expect(await ctx.db.auditLog.count({ where: { action: "feedback.handle", targetId: f.id } })).toBe(1); // 失败的操作不留审计
  });

  it("管理员列表里看不到用户的聊天、对象或报告：反馈之外的任何数据都不在返回里", async () => {
    const adminUser = await makeUser(ctx.db, { role: "ADMIN" });
    const user = await makeUser(ctx.db);
    const person = await createPeople(ctx.db).create(user.id, { nickname: "不应出现的对象昵称" });
    const f = await feedback().submit(user.id, { category: "OTHER", message: "只写了这句" });
    const item = (await admin().listFeedback(adminUser.id)).find((x) => x.id === f.id)!;
    expect(Object.keys(item).sort()).toEqual(["category", "createdAt", "handledAt", "id", "message", "snippet", "status", "userPhoneMasked"]);
    expect(JSON.stringify(item)).not.toContain(person.nickname);
  });
});

describe("账户删除与导出", () => {
  it("账户删除时反馈一并删除", async () => {
    const user = await makeUser(ctx.db);
    await feedback().submit(user.id, { category: "BUG", message: "将被删除" });
    const storage = createLocalStorage({ dir, secret: "test-storage-signing-secret-0123456789" });
    await createAccount(ctx.db, { storage }).deleteAccount(user.id);
    expect(await ctx.db.feedback.count({ where: { userId: user.id } })).toBe(0);
  });

  it("导出包含自己提交的反馈（含主动附上的片段），不含别人的", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    await feedback().submit(a.id, { category: "INACCURATE", message: "A 的反馈", snippet: "A 的片段" });
    await feedback().submit(b.id, { category: "BUG", message: "B 的反馈" });
    const out = await createExport(ctx.db).build(a.id);
    expect(out.feedback).toEqual([expect.objectContaining({ category: "INACCURATE", message: "A 的反馈", snippet: "A 的片段", status: "NEW" })]);
    expect(JSON.stringify(out)).not.toContain("B 的反馈");
  });
});
