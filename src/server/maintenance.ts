import type { Db } from "@/server/db";

const DAY = 24 * 60 * 60 * 1000;

/**
 * 清理已无用途的认证数据：已过期超过 1 天的验证码、超过 2 天的限流事件（最长窗口为 1 天）、已过期的会话。
 * 由 worker 定时执行。
 */
export async function purgeExpired(db: Db, now: Date = new Date()) {
  const [loginCodes, rateLimitEvents, sessions] = await Promise.all([
    db.loginCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY) } } }),
    db.rateLimitEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 2 * DAY) } } }),
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { loginCodes: loginCodes.count, rateLimitEvents: rateLimitEvents.count, sessions: sessions.count };
}

/** 超过 7 天仍未保存的导入批次连同暂存消息一并清理（docs/business/privacy-retention.md §2）。 */
export async function purgeStaleBatches(db: Db, now: Date = new Date()) {
  const r = await db.importBatch.deleteMany({
    where: { status: { not: "CONFIRMED" }, createdAt: { lt: new Date(now.getTime() - 7 * DAY) } },
  });
  return { batches: r.count };
}
