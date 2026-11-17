import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { testKeys as keys } from "../support/keys";
import { createAuth } from "@/server/auth/service";
import type { SmsSender } from "@/server/sms/types";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});


function setup(startAt = new Date("2026-03-01T08:00:00Z")) {
  let now = startAt;
  const sent: { phone: string; code: string }[] = [];
  const sms: SmsSender = { send: async (phone, code) => void sent.push({ phone, code }) };
  const auth = createAuth(ctx.db, { sms, keys, now: () => now });
  return {
    auth,
    sent,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    lastCode: () => sent[sent.length - 1].code,
  };
}

let phoneSeq = 0;
const newPhone = () => `139${String(10000000 + phoneSeq++).slice(-8)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;

async function invite(over: { maxUses?: number; expiresAt?: Date; revokedAt?: Date | null; code?: string } = {}) {
  const code = over.code ?? `INV${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await ctx.db.inviteCode.create({
    data: {
      code,
      maxUses: over.maxUses ?? 1,
      expiresAt: over.expiresAt ?? new Date("2027-01-01T00:00:00Z"),
      revokedAt: over.revokedAt ?? null,
    },
  });
  return code;
}

async function expectAuthError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ name: "AuthError", code });
}

describe("手机号验证码登录", () => {
  it("新用户凭邀请码注册并获得会话，退出后会话失效", async () => {
    const { auth, lastCode } = setup();
    const phone = newPhone();
    await auth.requestLoginCode(phone, "1.1.1.1");
    const r = await auth.verifyLoginCode({ phone, code: lastCode(), inviteCode: await invite(), ip: "1.1.1.1" });
    expect(r.isNewUser).toBe(true);
    const user = await auth.getSessionUser(r.token);
    expect(user?.id).toBe(r.userId);
    await auth.logout(r.token);
    expect(await auth.getSessionUser(r.token)).toBeNull();
  });

  it("手机号不以明文保存；不同写法视为同一手机号", async () => {
    const { auth, lastCode } = setup();
    const phone = newPhone();
    await auth.requestLoginCode(phone, "1.1.1.2");
    const r1 = await auth.verifyLoginCode({ phone: `+86 ${phone}`, code: lastCode(), inviteCode: await invite(), ip: "1.1.1.2" });
    const row = await ctx.db.user.findUniqueOrThrow({ where: { id: r1.userId } });
    expect(row.phoneHash).not.toContain(phone);
    expect(row.phoneEnc).not.toContain(phone);

    const t = setup(new Date("2026-03-02T08:00:00Z"));
    await t.auth.requestLoginCode(`+86${phone}`, "1.1.1.2");
    const r2 = await t.auth.verifyLoginCode({ phone, code: t.lastCode(), ip: "1.1.1.2" });
    expect(r2.userId).toBe(r1.userId);
    expect(r2.isNewUser).toBe(false);
  });

  it("非法手机号被拒绝，且不发送短信", async () => {
    const { auth, sent } = setup();
    await expectAuthError(auth.requestLoginCode("12345", "1.1.1.3"), "INVALID_PHONE");
    expect(sent).toHaveLength(0);
  });
});

describe("邀请码", () => {
  it("新手机号未提供邀请码：提示需要邀请码，验证码未被消耗，补充后仍可使用", async () => {
    const { auth, lastCode } = setup();
    const phone = newPhone();
    await auth.requestLoginCode(phone, "2.2.2.1");
    const code = lastCode();
    await expectAuthError(auth.verifyLoginCode({ phone, code, ip: "2.2.2.1" }), "INVITE_REQUIRED");
    const r = await auth.verifyLoginCode({ phone, code, inviteCode: await invite(), ip: "2.2.2.1" });
    expect(r.isNewUser).toBe(true);
  });

  it.each([
    ["不存在", async () => "NOPE-NOPE"],
    ["已过期", async () => invite({ expiresAt: new Date("2026-02-01T00:00:00Z") })],
    ["已撤销", async () => invite({ revokedAt: new Date("2026-02-01T00:00:00Z") })],
  ])("邀请码%s时拒绝注册，且不创建用户、验证码仍可在换用有效邀请码时使用", async (_label, make) => {
    const { auth, lastCode } = setup();
    const phone = newPhone();
    await auth.requestLoginCode(phone, "2.2.2.2");
    const code = lastCode();
    const before = await ctx.db.user.count();
    await expectAuthError(auth.verifyLoginCode({ phone, code, inviteCode: await make(), ip: "2.2.2.2" }), "INVITE_INVALID");
    expect(await ctx.db.user.count()).toBe(before);
    const r = await auth.verifyLoginCode({ phone, code, inviteCode: await invite(), ip: "2.2.2.2" });
    expect(r.isNewUser).toBe(true);
  });

  it("使用次数用尽后不可再用", async () => {
    const code = await invite({ maxUses: 1 });
    const a = setup();
    const p1 = newPhone();
    await a.auth.requestLoginCode(p1, "2.2.3.1");
    await a.auth.verifyLoginCode({ phone: p1, code: a.lastCode(), inviteCode: code, ip: "2.2.3.1" });
    const p2 = newPhone();
    await a.auth.requestLoginCode(p2, "2.2.3.2");
    await expectAuthError(a.auth.verifyLoginCode({ phone: p2, code: a.lastCode(), inviteCode: code, ip: "2.2.3.2" }), "INVITE_INVALID");
  });

  it("并发使用：次数为 3 的邀请码被 10 个新手机号同时使用，只有 3 个成功", async () => {
    const code = await invite({ maxUses: 3 });
    const phones = Array.from({ length: 10 }, newPhone);
    const t = setup();
    const codes = new Map<string, string>();
    for (const [i, p] of phones.entries()) {
      await t.auth.requestLoginCode(p, `3.3.${i}.1`);
      codes.set(p, t.lastCode());
    }
    const results = await Promise.allSettled(
      phones.map((p, i) => t.auth.verifyLoginCode({ phone: p, code: codes.get(p)!, inviteCode: code, ip: `3.3.${i}.1` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const row = await ctx.db.inviteCode.findUniqueOrThrow({ where: { code } });
    expect(row.usedCount).toBe(3);
  });
});

describe("验证码有效期、重发与错误次数", () => {
  it("5 分钟后过期", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "4.4.4.1");
    t.advance(5 * MIN + 1000);
    await expectAuthError(
      t.auth.verifyLoginCode({ phone, code: t.lastCode(), inviteCode: await invite(), ip: "4.4.4.1" }),
      "CODE_EXPIRED",
    );
  });

  it("验证码用过一次即失效", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "4.4.4.2");
    const code = t.lastCode();
    await t.auth.verifyLoginCode({ phone, code, inviteCode: await invite(), ip: "4.4.4.2" });
    await expectAuthError(t.auth.verifyLoginCode({ phone, code, ip: "4.4.4.2" }), "CODE_INVALID");
  });

  it("连续错误 5 次后验证码作废，正确的码也不能再用", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "4.4.4.3");
    const good = t.lastCode();
    const wrong = good === "000000" ? "111111" : "000000";
    const inv = await invite();
    for (let i = 0; i < 5; i++) {
      await expectAuthError(t.auth.verifyLoginCode({ phone, code: wrong, inviteCode: inv, ip: "4.4.4.3" }), "CODE_INVALID");
    }
    await expectAuthError(t.auth.verifyLoginCode({ phone, code: good, inviteCode: inv, ip: "4.4.4.3" }), "TOO_MANY_ATTEMPTS");
  });

  it("60 秒内不能重发；重发后旧验证码失效", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "4.4.4.4");
    const first = t.lastCode();
    t.advance(30_000);
    await expectAuthError(t.auth.requestLoginCode(phone, "4.4.4.4"), "TOO_SOON");
    t.advance(31_000);
    await t.auth.requestLoginCode(phone, "4.4.4.4");
    const second = t.lastCode();
    const inv = await invite();
    if (first !== second) {
      await expectAuthError(t.auth.verifyLoginCode({ phone, code: first, inviteCode: inv, ip: "4.4.4.4" }), "CODE_INVALID");
    }
    await t.auth.verifyLoginCode({ phone, code: second, inviteCode: inv, ip: "4.4.4.4" });
  });
});

describe("发送与验证限流", () => {
  it("同一手机号每小时最多 5 次", async () => {
    const t = setup();
    const phone = newPhone();
    for (let i = 0; i < 5; i++) {
      await t.auth.requestLoginCode(phone, "5.5.5.1");
      t.advance(61_000);
    }
    await expectAuthError(t.auth.requestLoginCode(phone, "5.5.5.1"), "RATE_LIMITED");
    t.advance(HOUR);
    await t.auth.requestLoginCode(phone, "5.5.5.1");
  });

  it("同一手机号每天最多 10 次", async () => {
    const t = setup();
    const phone = newPhone();
    for (let i = 0; i < 10; i++) {
      await t.auth.requestLoginCode(phone, "5.5.5.2");
      t.advance(i % 5 === 4 ? HOUR + 1000 : 61_000);
    }
    await expectAuthError(t.auth.requestLoginCode(phone, "5.5.5.2"), "RATE_LIMITED");
  });

  it("同一 IP 每小时最多向 20 个号码发送", async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) await t.auth.requestLoginCode(newPhone(), "5.5.5.3");
    await expectAuthError(t.auth.requestLoginCode(newPhone(), "5.5.5.3"), "RATE_LIMITED");
  });

  it("同一 IP 每小时验证尝试最多 30 次", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "5.5.5.4");
    for (let i = 0; i < 30; i++) {
      await t.auth.verifyLoginCode({ phone: newPhone(), code: "123456", ip: "5.5.5.4" }).catch(() => {});
    }
    await expectAuthError(
      t.auth.verifyLoginCode({ phone, code: t.lastCode(), inviteCode: await invite(), ip: "5.5.5.4" }),
      "RATE_LIMITED",
    );
  });
});

describe("会话与账户状态", () => {
  it("会话 14 天后过期", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "6.6.6.1");
    const r = await t.auth.verifyLoginCode({ phone, code: t.lastCode(), inviteCode: await invite(), ip: "6.6.6.1" });
    t.advance(13 * 24 * HOUR);
    expect(await t.auth.getSessionUser(r.token)).not.toBeNull();
    t.advance(2 * 24 * HOUR);
    expect(await t.auth.getSessionUser(r.token)).toBeNull();
  });

  it("被停用的用户不能登录，已有会话立即失效", async () => {
    const t = setup();
    const phone = newPhone();
    await t.auth.requestLoginCode(phone, "6.6.6.2");
    const r = await t.auth.verifyLoginCode({ phone, code: t.lastCode(), inviteCode: await invite(), ip: "6.6.6.2" });
    await ctx.db.user.update({ where: { id: r.userId }, data: { status: "SUSPENDED" } });
    expect(await t.auth.getSessionUser(r.token)).toBeNull();
    t.advance(2 * MIN);
    await t.auth.requestLoginCode(phone, "6.6.6.2");
    await expectAuthError(t.auth.verifyLoginCode({ phone, code: t.lastCode(), ip: "6.6.6.2" }), "ACCOUNT_SUSPENDED");
  });

  it("不存在的会话令牌返回空", async () => {
    const { auth } = setup();
    expect(await auth.getSessionUser("not-a-token")).toBeNull();
  });
});
