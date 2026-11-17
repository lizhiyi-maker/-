import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { createAdmin, ForbiddenError } from "@/server/admin/service";
import { createAuth } from "@/server/auth/service";
import { createQuota } from "@/server/quota/ledger";
import { NotFoundError, ValidationError } from "@/server/errors";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const admin = () => createAdmin(ctx.db, { keys });

describe("管理服务权限", () => {
  it("非管理员、已停用的管理员、不存在的操作者都被拒绝，且没有任何副作用", async () => {
    const user = await makeUser(ctx.db);
    const suspendedAdmin = await makeUser(ctx.db, { role: "ADMIN", status: "SUSPENDED" });
    const target = await makeUser(ctx.db);
    for (const actorId of [user.id, suspendedAdmin.id, "ghost"]) {
      const a = admin();
      await expect(a.createInvite(actorId, { maxUses: 1, validDays: 7 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(a.setUserStatus(actorId, target.id, "SUSPENDED")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(a.grantQuota(actorId, target.id, "ANALYSIS", 5, "x")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(a.listUsers(actorId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(a.listAudit(actorId)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await ctx.db.inviteCode.count()).toBe(0);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("ACTIVE");
    expect(await ctx.db.auditLog.count()).toBe(0);
  });
});

describe("管理操作与审计", () => {
  it("创建邀请码：新用户可用它注册，撤销后不可再用；均有审计记录", async () => {
    const root = await makeUser(ctx.db, { role: "ADMIN" });
    const a = admin();
    const inv = await a.createInvite(root.id, { maxUses: 2, validDays: 14, note: "内测一批" });
    expect(inv.code).toMatch(/^[A-Z2-9]{10}$/);
    expect(inv.maxUses).toBe(2);
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);

    const sent: string[] = [];
    const auth = createAuth(ctx.db, { sms: { send: async (_p, c) => void sent.push(c) }, keys });
    await auth.requestLoginCode("13700000001", "9.9.9.1");
    await auth.verifyLoginCode({ phone: "13700000001", code: sent[0], inviteCode: inv.code, ip: "9.9.9.1" });

    await a.revokeInvite(root.id, inv.id);
    await auth.requestLoginCode("13700000002", "9.9.9.2");
    await expect(auth.verifyLoginCode({ phone: "13700000002", code: sent[1], inviteCode: inv.code, ip: "9.9.9.2" })).rejects.toMatchObject({ code: "INVITE_INVALID" });

    const actions = (await a.listAudit(root.id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["invite.create", "invite.revoke"]));
  });

  it("停用用户使其会话立即失效，可恢复；不能停用自己", async () => {
    const root = await makeUser(ctx.db, { role: "ADMIN" });
    const target = await makeUser(ctx.db);
    const a = admin();
    const auth = createAuth(ctx.db, { sms: { send: async () => {} }, keys });
    const token = await auth.createSession(target.id);
    expect(await auth.getSessionUser(token)).not.toBeNull();

    await a.setUserStatus(root.id, target.id, "SUSPENDED");
    expect(await auth.getSessionUser(token)).toBeNull();
    await a.setUserStatus(root.id, target.id, "ACTIVE");
    await expect(a.setUserStatus(root.id, root.id, "SUSPENDED")).rejects.toThrow();
    const entries = await a.listAudit(root.id);
    expect(entries.filter((e) => e.targetId === target.id).map((e) => e.action)).toEqual(
      expect.arrayContaining(["user.suspend", "user.activate"]),
    );
  });

  it("补发额度：增加可用额度，审计记录操作者与数量，且不含任何聊天内容", async () => {
    const root = await makeUser(ctx.db, { role: "ADMIN" });
    const target = await makeUser(ctx.db);
    await admin().grantQuota(root.id, target.id, "SCREENSHOT", 30, "内测补发");
    expect(await createQuota(ctx.db).getAvailable(target.id, "SCREENSHOT")).toBe(150);
    const entry = (await admin().listAudit(root.id)).find((e) => e.action === "quota.grant" && e.targetId === target.id)!;
    expect(entry.actorId).toBe(root.id);
    expect(entry.meta).toMatchObject({ kind: "SCREENSHOT", amount: 30, reason: "内测补发" });
  });

  it("用户列表只显示脱敏手机号", async () => {
    const root = await makeUser(ctx.db, { role: "ADMIN" });
    const sent: string[] = [];
    const a2 = createAuth(ctx.db, { sms: { send: async (_p, c) => void sent.push(c) }, keys });
    const inv = await admin().createInvite(root.id, { maxUses: 1, validDays: 1 });
    await a2.requestLoginCode("13611112222", "8.8.8.8");
    await a2.verifyLoginCode({ phone: "13611112222", code: sent[0], inviteCode: inv.code, ip: "8.8.8.8" });
    const rows = await admin().listUsers(root.id);
    const masked = rows.find((r) => r.phoneMasked === "136****2222");
    expect(masked).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain("13611112222");
  });
});

describe("管理操作的错误与审计一致性", () => {
  it("目标不存在或参数无效时返回可展示的领域错误，且不留下审计记录", async () => {
    const root = await makeUser(ctx.db, { role: "ADMIN" });
    const a = admin();
    const before = await ctx.db.auditLog.count();
    await expect(a.revokeInvite(root.id, "no-such-invite")).rejects.toBeInstanceOf(NotFoundError);
    await expect(a.setUserStatus(root.id, "no-such-user", "SUSPENDED")).rejects.toBeInstanceOf(NotFoundError);
    await expect(a.grantQuota(root.id, "no-such-user", "ANALYSIS", 5, "x")).rejects.toBeInstanceOf(NotFoundError);
    await expect(a.grantQuota(root.id, root.id, "ANALYSIS", 0, "x")).rejects.toBeInstanceOf(ValidationError);
    await expect(a.createInvite(root.id, { maxUses: 0, validDays: 7 })).rejects.toBeInstanceOf(ValidationError);
    await expect(a.setUserStatus(root.id, root.id, "SUSPENDED")).rejects.toBeInstanceOf(ValidationError);
    expect(await ctx.db.auditLog.count()).toBe(before);
  });
});
