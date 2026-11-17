import { randomInt } from "node:crypto";
import type { Db } from "@/server/db";
import type { QuotaKind, UserStatus } from "@/generated/prisma/enums";
import { NotFoundError, ValidationError } from "@/server/errors";
import { createQuota } from "@/server/quota/ledger";
import { decryptPhone, maskPhone } from "@/server/auth/phone";

export class ForbiddenError extends Error {
  constructor() {
    super("无权执行此操作");
    this.name = "ForbiddenError";
  }
}

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

// 去掉易混淆字符（0/O/1/I/L）
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const generateCode = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

type InviteStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "EXHAUSTED";

/**
 * 管理服务：每个操作都先校验操作者是启用状态的管理员；
 * 变更与审计记录在同一事务内提交，失败的操作不留审计。
 * 审计与列表都不包含聊天内容；用户列表只显示脱敏手机号。
 */
export function createAdmin(db: Db, deps: { keys: { encKey: string }; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const quota = createQuota(db, { now });

  async function assertAdmin(actorId: string) {
    const actor = await db.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") throw new ForbiddenError();
  }

  const audit = (tx: Tx, actorId: string, action: string, targetType: string, targetId: string | null, meta?: object) =>
    tx.auditLog.create({
      data: { actorId, action, targetType, targetId, meta: meta ?? undefined, createdAt: now() },
    });

  async function createInvite(actorId: string, input: { maxUses: number; validDays: number; note?: string }) {
    await assertAdmin(actorId);
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1) throw new ValidationError("使用次数必须是正整数");
    if (!Number.isInteger(input.validDays) || input.validDays < 1) throw new ValidationError("有效天数必须是正整数");
    return db.$transaction(async (tx) => {
      const invite = await tx.inviteCode.create({
        data: {
          code: generateCode(),
          maxUses: input.maxUses,
          expiresAt: new Date(now().getTime() + input.validDays * 86400_000),
          note: input.note?.trim() || null,
          createdById: actorId,
          createdAt: now(),
        },
      });
      await audit(tx, actorId, "invite.create", "InviteCode", invite.id, { maxUses: invite.maxUses, validDays: input.validDays });
      return invite;
    });
  }

  async function revokeInvite(actorId: string, inviteId: string) {
    await assertAdmin(actorId);
    await db.$transaction(async (tx) => {
      const r = await tx.inviteCode.updateMany({ where: { id: inviteId }, data: { revokedAt: now() } });
      if (r.count === 0) throw new NotFoundError("邀请码");
      await audit(tx, actorId, "invite.revoke", "InviteCode", inviteId);
    });
  }

  async function setUserStatus(actorId: string, userId: string, status: UserStatus) {
    await assertAdmin(actorId);
    if (actorId === userId) throw new ValidationError("不能修改自己的状态");
    await db.$transaction(async (tx) => {
      const r = await tx.user.updateMany({ where: { id: userId }, data: { status } });
      if (r.count === 0) throw new NotFoundError("用户");
      if (status === "SUSPENDED") await tx.session.deleteMany({ where: { userId } });
      await audit(tx, actorId, status === "SUSPENDED" ? "user.suspend" : "user.activate", "User", userId);
    });
  }

  async function grantQuota(actorId: string, userId: string, kind: QuotaKind, amount: number, reason: string) {
    await assertAdmin(actorId);
    await db.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new NotFoundError("用户");
      await quota.grant(userId, kind, amount, { actorId, reason }, tx);
      await audit(tx, actorId, "quota.grant", "User", userId, { kind, amount, reason });
    });
  }

  async function listInvites(actorId: string) {
    await assertAdmin(actorId);
    const rows = await db.inviteCode.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    const t = now().getTime();
    const status = (i: (typeof rows)[number]): InviteStatus =>
      i.revokedAt ? "REVOKED" : i.expiresAt.getTime() <= t ? "EXPIRED" : i.usedCount >= i.maxUses ? "EXHAUSTED" : "ACTIVE";
    return rows.map((i) => ({ ...i, status: status(i) }));
  }

  async function listUsers(actorId: string) {
    await assertAdmin(actorId);
    const users = await db.user.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return users.map((u) => ({
      id: u.id,
      phoneMasked: maskPhone(decryptPhone(u.phoneEnc, deps.keys.encKey)),
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
  }

  async function listAudit(actorId: string) {
    await assertAdmin(actorId);
    return db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }

  return { createInvite, revokeInvite, setUserStatus, grantQuota, listInvites, listUsers, listAudit };
}

export type Admin = ReturnType<typeof createAdmin>;
