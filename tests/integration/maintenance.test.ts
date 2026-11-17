import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { makeUser } from "../support/factories";
import { purgeExpired } from "@/server/maintenance";
import { ensureAdmin } from "@/server/admin/bootstrap";
import { createAuth } from "@/server/auth/service";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const DAY = 86400_000;

describe("过期数据清理", () => {
  it("清理过期验证码、旧限流记录与过期会话，保留仍有效的记录", async () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const user = await makeUser(ctx.db);
    await ctx.db.loginCode.createMany({
      data: [
        { phoneHash: "p", codeHash: "x", expiresAt: new Date(now.getTime() - 2 * DAY), createdAt: new Date(now.getTime() - 2 * DAY) },
        { phoneHash: "p", codeHash: "y", expiresAt: new Date(now.getTime() + 60_000), createdAt: now },
      ],
    });
    await ctx.db.rateLimitEvent.createMany({
      data: [{ key: "k", createdAt: new Date(now.getTime() - 3 * DAY) }, { key: "k", createdAt: now }],
    });
    await ctx.db.session.createMany({
      data: [
        { userId: user.id, tokenHash: "old", expiresAt: new Date(now.getTime() - DAY) },
        { userId: user.id, tokenHash: "live", expiresAt: new Date(now.getTime() + DAY) },
      ],
    });

    const r = await purgeExpired(ctx.db, now);
    expect(r).toEqual({ loginCodes: 1, rateLimitEvents: 1, sessions: 1 });
    expect(await ctx.db.loginCode.count()).toBe(1);
    expect(await ctx.db.rateLimitEvent.count()).toBe(1);
    expect(await ctx.db.session.count()).toBe(1);
  });
});

describe("管理员引导", () => {
  it("按手机号创建管理员；重复执行不重复创建；已有普通用户被提升为管理员且保持启用", async () => {
    const a = await ensureAdmin(ctx.db, "13500000001", keys);
    expect(a.created).toBe(true);
    const again = await ensureAdmin(ctx.db, "135 0000 0001", keys);
    expect(again.created).toBe(false);
    expect(again.userId).toBe(a.userId);
    expect(await ctx.db.user.count({ where: { role: "ADMIN" } })).toBeGreaterThanOrEqual(1);

    const sent: string[] = [];
    const auth = createAuth(ctx.db, { sms: { send: async (_p, c) => void sent.push(c) }, keys });
    await ctx.db.user.update({ where: { id: a.userId }, data: { role: "USER", status: "SUSPENDED" } });
    await ensureAdmin(ctx.db, "13500000001", keys);
    const row = await ctx.db.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(row.role).toBe("ADMIN");
    expect(row.status).toBe("ACTIVE");

    // 管理员无需邀请码即可用验证码登录
    await auth.requestLoginCode("13500000001", "7.7.7.7");
    const login = await auth.verifyLoginCode({ phone: "13500000001", code: sent[0], ip: "7.7.7.7" });
    expect(login.userId).toBe(a.userId);
  });

  it("非法手机号被拒绝", async () => {
    await expect(ensureAdmin(ctx.db, "123", keys)).rejects.toThrow();
  });
});
