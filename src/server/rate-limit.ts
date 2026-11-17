import type { Db } from "@/server/db";

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/**
 * 滑动窗口限流（PostgreSQL 实现，内测规模无需 Redis）。
 * 同一 key 的检查与写入由 advisory lock 串行化；通过则记录一次事件。
 * 返回 null 表示放行，否则返回需等待的毫秒数。
 */
export async function consumeRateLimit(db: Db | Tx, key: string, rule: RateLimit, now: Date): Promise<number | null> {
  const run = async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rl:${key}`}, 0))`;
    const since = new Date(now.getTime() - rule.windowMs);
    const events = await tx.rateLimitEvent.findMany({
      where: { key, createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (events.length >= rule.limit) {
      const oldestCounted = events[events.length - rule.limit];
      return Math.max(1, oldestCounted.createdAt.getTime() + rule.windowMs - now.getTime());
    }
    await tx.rateLimitEvent.create({ data: { key, createdAt: now } });
    return null;
  };
  return "$transaction" in db ? db.$transaction(run) : run(db);
}
