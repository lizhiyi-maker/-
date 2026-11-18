import { randomInt } from "node:crypto";
import type { Db } from "@/server/db";
import type { QuotaKind } from "@/generated/prisma/enums";
import { NotFoundError, ValidationError } from "@/server/errors";
import { createQuota } from "@/server/quota/ledger";
import { decryptPhone, maskPhone } from "@/server/auth/phone";
import type { Usage } from "@/server/usage/service";

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
export function createAdmin(db: Db, deps: { keys: { encKey: string }; now?: () => Date; usage?: Pick<Usage, "summary"> }) {
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

  async function setUserStatus(actorId: string, userId: string, status: "ACTIVE" | "SUSPENDED") {
    await assertAdmin(actorId);
    if (actorId === userId) throw new ValidationError("不能修改自己的状态");
    await db.$transaction(async (tx) => {
      // 用户发起了账户删除：不能被恢复或改状态，删除流程会完成它
      const r = await tx.user.updateMany({ where: { id: userId, status: { not: "DELETING" } }, data: { status } });
      if (r.count === 0) {
        if (await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new ValidationError("该用户正在删除账户，不能修改状态");
        throw new NotFoundError("用户");
      }
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

  // ───────── 后台运营：任务状态、成本、反馈（只读，不含聊天内容） ─────────

  /** 排队/运行超过这个时间没有结果视为卡住（与 worker 的清扫任务一致，docs/business/state-machines.md）。 */
  const STUCK_AFTER_MS = 15 * 60_000;
  const phoneMaskedOf = async (userIds: string[]) => {
    const users = await db.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, phoneEnc: true } });
    return new Map(users.map((u) => [u.id, maskPhone(decryptPhone(u.phoneEnc, deps.keys.encKey))]));
  };

  /**
   * 任务状态（分析 + 截图识别）：近 24 小时各状态数量、失败错误码分布、卡住的任务、最近 50 条任务。
   * 只含状态、时间、错误码与脱敏手机号，不含聊天、昵称、文件路径；管理员只读，没有重试/取消/退款操作。
   */
  async function taskStatus(actorId: string) {
    await assertAdmin(actorId);
    const t = now().getTime();
    const since = new Date(t - 86_400_000);
    const stuckBefore = new Date(t - STUCK_AFTER_MS);
    const [aStatus, sStatus, aErrors, sErrors, aStuck, sStuck, aRecent, sRecent] = await Promise.all([
      db.analysis.groupBy({ by: ["status"], where: { queuedAt: { gte: since } }, _count: { _all: true } }),
      db.screenshot.groupBy({ by: ["status"], where: { queuedAt: { gte: since } }, _count: { _all: true } }),
      db.analysis.groupBy({ by: ["errorCode"], where: { queuedAt: { gte: since }, status: { in: ["FAILED", "INVALIDATED"] } }, _count: { _all: true } }),
      db.screenshot.groupBy({ by: ["errorCode"], where: { queuedAt: { gte: since }, status: "FAILED" }, _count: { _all: true } }),
      db.analysis.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] }, queuedAt: { lt: stuckBefore } }, select: { id: true, userId: true, status: true, queuedAt: true }, take: 50 }),
      db.screenshot.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] }, queuedAt: { lt: stuckBefore } }, select: { id: true, userId: true, status: true, queuedAt: true }, take: 50 }),
      db.analysis.findMany({ orderBy: { queuedAt: "desc" }, take: 50, select: { id: true, userId: true, status: true, errorCode: true, queuedAt: true, startedAt: true, finishedAt: true } }),
      db.screenshot.findMany({ where: { queuedAt: { not: null } }, orderBy: { queuedAt: "desc" }, take: 50, select: { id: true, userId: true, status: true, errorCode: true, queuedAt: true, finishedAt: true, attempts: true } }),
    ]);

    const toCounts = (rows: { status: string; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const toErrors = (rows: { errorCode: string | null; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.errorCode ?? "UNKNOWN", r._count._all])) as Record<string, number>;
    const recentAll = [
      ...aRecent.map((a) => ({ kind: "ANALYSIS" as const, id: a.id, userId: a.userId, status: a.status as string, errorCode: a.errorCode, queuedAt: a.queuedAt, durationMs: a.finishedAt ? a.finishedAt.getTime() - (a.startedAt ?? a.queuedAt).getTime() : null, attempts: null as number | null })),
      ...sRecent.map((s) => ({ kind: "RECOGNITION" as const, id: s.id, userId: s.userId, status: s.status as string, errorCode: s.errorCode, queuedAt: s.queuedAt!, durationMs: s.finishedAt ? s.finishedAt.getTime() - s.queuedAt!.getTime() : null, attempts: s.attempts as number | null })),
    ]
      .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())
      .slice(0, 50);
    const stuckAll = [...aStuck.map((x) => ({ kind: "ANALYSIS" as const, ...x })), ...sStuck.map((x) => ({ kind: "RECOGNITION" as const, ...x }))];
    const masked = await phoneMaskedOf([...recentAll.map((r) => r.userId), ...stuckAll.map((r) => r.userId)]);
    const stripUser = <T extends { userId: string }>({ userId, ...rest }: T) => ({ ...rest, userPhoneMasked: masked.get(userId) ?? "—" });

    return {
      windowHours: 24,
      stuckAfterMinutes: STUCK_AFTER_MS / 60_000,
      analysis: { counts: toCounts(aStatus), errorCodes: toErrors(aErrors) },
      recognition: { counts: toCounts(sStatus), errorCodes: toErrors(sErrors) },
      stuck: stuckAll.map((s) => ({ ...stripUser(s), ageMinutes: Math.floor((t - s.queuedAt!.getTime()) / 60_000) })),
      recent: recentAll.map(stripUser),
    };
  }

  /** 成本汇总：最近 days 天的模型用量与估算成本。只含用量与成本，不含内容。 */
  async function costSummary(actorId: string, days = 30) {
    await assertAdmin(actorId);
    if (!deps.usage) throw new ValidationError("用量记录未启用");
    return deps.usage.summary(days);
  }

  /** 用户反馈列表（未处理的在前，新的在前）：手机号脱敏；内容只有用户自己写下与主动粘贴的片段，管理员不能借此浏览聊天。 */
  async function listFeedback(actorId: string) {
    await assertAdmin(actorId);
    const rows = await db.feedback.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 });
    const masked = await phoneMaskedOf(rows.map((r) => r.userId));
    return rows.map((r) => ({ id: r.id, userPhoneMasked: masked.get(r.userId) ?? "—", category: r.category, message: r.message, snippet: r.snippet, status: r.status, createdAt: r.createdAt, handledAt: r.handledAt }));
  }

  async function handleFeedback(actorId: string, feedbackId: string) {
    await assertAdmin(actorId);
    await db.$transaction(async (tx) => {
      const r = await tx.feedback.updateMany({ where: { id: feedbackId, status: "NEW" }, data: { status: "HANDLED", handledAt: now(), handledBy: actorId } });
      if (r.count === 0) throw new NotFoundError("反馈");
      await audit(tx, actorId, "feedback.handle", "Feedback", feedbackId); // 审计不含反馈内容
    });
  }

  return { createInvite, revokeInvite, setUserStatus, grantQuota, listInvites, listUsers, listAudit, taskStatus, costSummary, listFeedback, handleFeedback };
}

export type Admin = ReturnType<typeof createAdmin>;
