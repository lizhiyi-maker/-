import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "@/server/db";
import { consumeRateLimit, type RateLimit } from "@/server/rate-limit";
import type { SmsSender } from "@/server/sms/types";
import { encryptPhone, hashPhone, normalizePhone } from "./phone";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 初始建议值（D6，待你确认）；见 docs/open-decisions.md。 */
export const authConfig = {
  codeLength: 6,
  codeTtlMs: 5 * MIN,
  resendIntervalMs: 60_000,
  maxCodeAttempts: 5,
  sendPerPhoneHour: { limit: 5, windowMs: HOUR } satisfies RateLimit,
  sendPerPhoneDay: { limit: 10, windowMs: DAY } satisfies RateLimit,
  sendPerIpHour: { limit: 20, windowMs: HOUR } satisfies RateLimit,
  verifyPerIpHour: { limit: 30, windowMs: HOUR } satisfies RateLimit,
  sessionTtlMs: 14 * DAY,
};

export type AuthErrorCode =
  | "INVALID_PHONE"
  | "TOO_SOON"
  | "RATE_LIMITED"
  | "SMS_FAILED"
  | "CODE_INVALID"
  | "CODE_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  | "INVITE_REQUIRED"
  | "INVITE_INVALID"
  | "ACCOUNT_SUSPENDED";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthDeps {
  sms: SmsSender;
  keys: { hmacKey: string; encKey: string };
  now?: () => Date;
}

export interface SessionUser {
  id: string;
  role: "USER" | "ADMIN";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createAuth(db: Db, deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());
  const { hmacKey, encKey } = deps.keys;
  const cfg = authConfig;

  const codeHash = (phoneHash: string, code: string) => createHmac("sha256", hmacKey).update(`${phoneHash}:${code}`).digest("hex");

  async function limit(key: string, rule: RateLimit) {
    const wait = await consumeRateLimit(db, key, rule, now());
    if (wait !== null) throw new AuthError("RATE_LIMITED", "请求过于频繁，请稍后再试", wait);
  }

  async function requestLoginCode(rawPhone: string, ip: string | null): Promise<{ retryAfterMs: number }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new AuthError("INVALID_PHONE", "请输入有效的中国大陆手机号");
    const phoneHash = hashPhone(phone, hmacKey);
    const t = now();

    const latest = await db.loginCode.findFirst({ where: { phoneHash }, orderBy: { createdAt: "desc" } });
    if (latest && t.getTime() - latest.createdAt.getTime() < cfg.resendIntervalMs) {
      throw new AuthError("TOO_SOON", "发送过于频繁，请稍后再试", latest.createdAt.getTime() + cfg.resendIntervalMs - t.getTime());
    }

    await limit(`sms:ip:${ip ?? "unknown"}`, cfg.sendPerIpHour);
    await limit(`sms:phone:h:${phoneHash}`, cfg.sendPerPhoneHour);
    await limit(`sms:phone:d:${phoneHash}`, cfg.sendPerPhoneDay);

    const code = String(randomInt(0, 10 ** cfg.codeLength)).padStart(cfg.codeLength, "0");
    const created = await db.$transaction(async (tx) => {
      await tx.loginCode.updateMany({ where: { phoneHash, consumedAt: null }, data: { consumedAt: t } });
      return tx.loginCode.create({
        data: { phoneHash, codeHash: codeHash(phoneHash, code), expiresAt: new Date(t.getTime() + cfg.codeTtlMs), createdAt: t },
      });
    });
    try {
      await deps.sms.send(phone, code);
    } catch {
      await db.loginCode.delete({ where: { id: created.id } });
      throw new AuthError("SMS_FAILED", "短信发送失败，请稍后重试");
    }
    return { retryAfterMs: cfg.resendIntervalMs };
  }

  type Mismatch = { failure: AuthError };

  async function verifyLoginCode(input: {
    phone: string;
    code: string;
    inviteCode?: string;
    ip: string | null;
  }): Promise<{ token: string; userId: string; isNewUser: boolean }> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new AuthError("INVALID_PHONE", "请输入有效的中国大陆手机号");
    await limit(`verify:ip:${input.ip ?? "unknown"}`, cfg.verifyPerIpHour);
    const phoneHash = hashPhone(phone, hmacKey);
    const t = now();
    const inviteCode = input.inviteCode?.trim().toUpperCase() || undefined;

    // 校验验证码、核销邀请码、创建用户在同一事务内；邀请码问题会回滚（验证码不被消耗）。
    // 验证码错误时需要保留"错误次数 +1"，因此以返回值而不是抛出异常结束事务。
    const outcome = await db.$transaction(async (tx): Promise<Mismatch | { userId: string; isNewUser: boolean }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`login:${phoneHash}`}, 0))`;
      const row = await tx.loginCode.findFirst({ where: { phoneHash, consumedAt: null }, orderBy: { createdAt: "desc" } });
      if (!row) return { failure: new AuthError("CODE_INVALID", "验证码不正确") };
      if (row.expiresAt.getTime() <= t.getTime()) return { failure: new AuthError("CODE_EXPIRED", "验证码已过期，请重新获取") };
      if (row.attempts >= cfg.maxCodeAttempts) {
        return { failure: new AuthError("TOO_MANY_ATTEMPTS", "错误次数过多，请重新获取验证码") };
      }
      if (!safeEqualHex(row.codeHash, codeHash(phoneHash, input.code))) {
        await tx.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
        return { failure: new AuthError("CODE_INVALID", "验证码不正确") };
      }

      const existing = await tx.user.findUnique({ where: { phoneHash } });
      if (existing) {
        if (existing.status !== "ACTIVE") throw new AuthError("ACCOUNT_SUSPENDED", "账号已被停用，请联系管理员");
        await tx.loginCode.update({ where: { id: row.id }, data: { consumedAt: t } });
        await tx.user.update({ where: { id: existing.id }, data: { lastLoginAt: t } });
        return { userId: existing.id, isNewUser: false };
      }

      if (!inviteCode) throw new AuthError("INVITE_REQUIRED", "新用户需要邀请码");
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "InviteCode" SET "usedCount" = "usedCount" + 1
        WHERE "code" = ${inviteCode} AND "revokedAt" IS NULL AND "expiresAt" > ${t} AND "usedCount" < "maxUses"
        RETURNING "id"`;
      if (claimed.length === 0) throw new AuthError("INVITE_INVALID", "邀请码无效、已过期或已用完");

      await tx.loginCode.update({ where: { id: row.id }, data: { consumedAt: t } });
      const user = await tx.user.create({
        data: { phoneHash, phoneEnc: encryptPhone(phone, encKey), lastLoginAt: t, createdAt: t },
      });
      await tx.inviteRedemption.create({ data: { inviteId: claimed[0].id, userId: user.id, createdAt: t } });
      return { userId: user.id, isNewUser: true };
    });

    if ("failure" in outcome) throw outcome.failure;
    const token = await createSession(outcome.userId);
    return { token, ...outcome };
  }

  async function createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    await db.session.create({
      data: { userId, tokenHash: sha256(token), createdAt: t, lastUsedAt: t, expiresAt: new Date(t.getTime() + cfg.sessionTtlMs) },
    });
    return token;
  }

  async function getSessionUser(token: string | undefined | null): Promise<SessionUser | null> {
    if (!token) return null;
    const session = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.expiresAt.getTime() <= now().getTime()) return null;
    if (session.user.status !== "ACTIVE") return null;
    return { id: session.user.id, role: session.user.role };
  }

  async function logout(token: string): Promise<void> {
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }

  return { requestLoginCode, verifyLoginCode, getSessionUser, logout, createSession };
}

export type Auth = ReturnType<typeof createAuth>;
