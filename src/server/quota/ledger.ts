import type { Db } from "@/server/db";
import type { QuotaKind } from "@/generated/prisma/enums";
import { ValidationError } from "@/server/errors";
import { quotaConfig, type QuotaConfig } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS: QuotaKind[] = ["SCREENSHOT", "ANALYSIS"];

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

export class InsufficientQuotaError extends QuotaError {
  constructor(
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`额度不足：需要 ${requested}，剩余 ${available}`);
    this.name = "InsufficientQuotaError";
  }
}

export interface QuotaOptions {
  now?: () => Date;
  config?: QuotaConfig;
}

/**
 * 额度账本。每个变动是一条流水；可用额度 = 当期流水 delta 之和。
 * 预留→结算/退还；以 (user, kind, taskKey, type) 唯一保证重试幂等；
 * 同一用户同一类额度的写操作用事务级 advisory lock 串行化，保证并发不超额。
 */
export function createQuota(db: Db, opts: QuotaOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const config = opts.config ?? quotaConfig;

  const defaultGrant = (kind: QuotaKind) =>
    kind === "SCREENSHOT" ? config.screenshot.perPeriod : config.analysis.perPeriod;

  /** 周期从用户创建时刻起每 periodDays 天一个；key 形如 p0、p1。 */
  function currentPeriod(createdAt: Date) {
    const span = config.periodDays * DAY_MS;
    const index = Math.max(0, Math.floor((now().getTime() - createdAt.getTime()) / span));
    return { key: `p${index}`, endsAt: new Date(createdAt.getTime() + (index + 1) * span) };
  }

  async function lock(tx: Tx, userId: string, kind: QuotaKind) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${userId}:${kind}`}, 0))`;
  }

  async function ensurePeriodGrant(tx: Tx, userId: string, kind: QuotaKind) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
    const period = currentPeriod(user.createdAt);
    await tx.quotaEntry.createMany({
      data: [
        {
          userId,
          kind,
          type: "GRANT",
          delta: defaultGrant(kind),
          amount: defaultGrant(kind),
          taskKey: `period:${period.key}`,
          periodKey: period.key,
          reason: "周期额度",
        },
      ],
      skipDuplicates: true,
    });
    return period;
  }

  async function availableIn(tx: Tx, userId: string, kind: QuotaKind, periodKey: string) {
    const agg = await tx.quotaEntry.aggregate({ where: { userId, kind, periodKey }, _sum: { delta: true } });
    return agg._sum.delta ?? 0;
  }

  const find = (tx: Tx, userId: string, kind: QuotaKind, taskKey: string, type: "RESERVE" | "SETTLE" | "RELEASE") =>
    tx.quotaEntry.findFirst({ where: { userId, kind, taskKey, type } });

  function assertPositiveInt(n: number, label: string) {
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label}必须是正整数`);
  }

  async function getAvailable(userId: string, kind: QuotaKind): Promise<number> {
    return db.$transaction(async (tx) => {
      await lock(tx, userId, kind);
      const period = await ensurePeriodGrant(tx, userId, kind);
      return availableIn(tx, userId, kind, period.key);
    });
  }

  async function getSummary(userId: string) {
    const [SCREENSHOT, ANALYSIS] = await Promise.all(KINDS.map((k) => getAvailable(userId, k)));
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
    return { SCREENSHOT, ANALYSIS, resetsAt: currentPeriod(user.createdAt).endsAt };
  }

  /**
   * 管理员补发：计入当期额度，随周期结束作废。
   * 传入 client 时在调用方的事务内执行（用于与审计记录同事务提交）。
   */
  async function grant(
    userId: string,
    kind: QuotaKind,
    amount: number,
    meta: { actorId: string; reason: string },
    client?: Tx,
  ) {
    assertPositiveInt(amount, "补发数量");
    const run = async (tx: Tx) => {
      await lock(tx, userId, kind);
      const period = await ensurePeriodGrant(tx, userId, kind);
      await tx.quotaEntry.create({
        data: { userId, kind, type: "GRANT", delta: amount, amount, periodKey: period.key, reason: meta.reason, actorId: meta.actorId },
      });
    };
    if (client) await run(client);
    else await db.$transaction(run);
  }

  /**
   * 原子预留；同一 taskKey 重试复用已有预留（不重复扣减）。
   * 若该 taskKey 的额度已因系统失败退还，沿用它会让重试免费执行，因此拒绝；
   * 调用方应对每次尝试使用新的 taskKey（如 `${taskId}:${attempt}`）。
   */
  async function reserve(userId: string, kind: QuotaKind, amount: number, taskKey: string) {
    assertPositiveInt(amount, "预留数量");
    await db.$transaction(async (tx) => {
      await lock(tx, userId, kind);
      if (await find(tx, userId, kind, taskKey, "RESERVE")) {
        const settled = await find(tx, userId, kind, taskKey, "SETTLE");
        if (!settled && (await find(tx, userId, kind, taskKey, "RELEASE"))) {
          throw new QuotaError("该任务的额度已退还；重试请使用新的任务键重新预留");
        }
        return;
      }
      const period = await ensurePeriodGrant(tx, userId, kind);
      const available = await availableIn(tx, userId, kind, period.key);
      if (available < amount) throw new InsufficientQuotaError(available, amount);
      await tx.quotaEntry.create({
        data: { userId, kind, type: "RESERVE", delta: -amount, amount, taskKey, periodKey: period.key },
      });
    });
  }

  /** 成功结算；used 小于预留量时，差额一并退还。重复结算无副作用。 */
  async function settle(userId: string, kind: QuotaKind, taskKey: string, opts: { used?: number } = {}) {
    await db.$transaction(async (tx) => {
      await lock(tx, userId, kind);
      const reservation = await find(tx, userId, kind, taskKey, "RESERVE");
      if (!reservation) throw new QuotaError("没有对应的额度预留");
      if (await find(tx, userId, kind, taskKey, "SETTLE")) return;
      if (await find(tx, userId, kind, taskKey, "RELEASE")) throw new QuotaError("该任务已退还额度，不能结算");
      const used = opts.used ?? reservation.amount;
      if (!Number.isInteger(used) || used < 0 || used > reservation.amount) {
        throw new QuotaError("实际使用量必须在 0 到预留量之间");
      }
      await tx.quotaEntry.create({
        data: { userId, kind, type: "SETTLE", delta: 0, amount: used, taskKey, periodKey: reservation.periodKey },
      });
      if (used < reservation.amount) {
        const rest = reservation.amount - used;
        await tx.quotaEntry.create({
          data: {
            userId,
            kind,
            type: "RELEASE",
            delta: rest,
            amount: rest,
            taskKey,
            periodKey: reservation.periodKey,
            reason: "部分使用，退还未使用部分",
          },
        });
      }
    });
  }

  /** 系统失败/任务作废：退还全部预留。重复退还无副作用；已结算的任务不可退还。 */
  async function release(userId: string, kind: QuotaKind, taskKey: string, reason = "系统失败退还") {
    await db.$transaction(async (tx) => {
      await lock(tx, userId, kind);
      const reservation = await find(tx, userId, kind, taskKey, "RESERVE");
      if (!reservation) throw new QuotaError("没有对应的额度预留");
      if (await find(tx, userId, kind, taskKey, "SETTLE")) throw new QuotaError("该任务已结算，不能退还");
      if (await find(tx, userId, kind, taskKey, "RELEASE")) return;
      await tx.quotaEntry.create({
        data: {
          userId,
          kind,
          type: "RELEASE",
          delta: reservation.amount,
          amount: reservation.amount,
          taskKey,
          periodKey: reservation.periodKey,
          reason,
        },
      });
    });
  }

  return { getAvailable, getSummary, grant, reserve, settle, release };
}

export type Quota = ReturnType<typeof createQuota>;
