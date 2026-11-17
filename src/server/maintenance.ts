import type { Db } from "@/server/db";
import type { FileStorage } from "@/server/storage/types";

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

/** 超过 7 天仍未保存的导入批次连同暂存消息与原图一并清理（docs/business/privacy-retention.md §2）。 */
export async function purgeStaleBatches(db: Db, now: Date = new Date(), storage?: FileStorage) {
  const where = { status: { not: "CONFIRMED" as const }, createdAt: { lt: new Date(now.getTime() - 7 * DAY) } };
  const shots = storage ? await db.screenshot.findMany({ where: { batch: where, purgedAt: null }, select: { storageKey: true } }) : [];
  const r = await db.importBatch.deleteMany({ where });
  for (const s of shots) await storage!.delete(s.storageKey).catch(() => {});
  return { batches: r.count };
}

/**
 * 删除已确认批次的原图文件：确认保存时已停止访问，这里做物理删除（目标 24 小时内，由 worker 每小时执行）。
 * 记录保留（仅用于按哈希查重），文件删除后写入 purgedAt。
 */
export async function purgeRevokedOriginals(db: Db, storage: FileStorage, now: Date = new Date()) {
  const rows = await db.screenshot.findMany({ where: { revokedAt: { lte: now }, purgedAt: null }, select: { id: true, storageKey: true } });
  let files = 0;
  for (const r of rows) {
    try {
      await storage.delete(r.storageKey);
    } catch {
      continue; // 下次再试
    }
    await db.screenshot.update({ where: { id: r.id }, data: { purgedAt: now } });
    files++;
  }
  return { files };
}

/**
 * 清理孤儿文件：存储里没有对应截图记录、且超过 1 小时的文件（对象/账户删除、上传中途失败等留下的）。
 * 已被撤销但记录仍在的文件由 purgeRevokedOriginals 处理，这里不动。
 */
export async function purgeOrphanFiles(db: Db, storage: FileStorage, now: Date = new Date()) {
  const cutoff = now.getTime() - 3600_000;
  const objects = (await storage.list()).filter((o) => o.modifiedAt.getTime() < cutoff);
  if (objects.length === 0) return { files: 0 };
  const known = new Set((await db.screenshot.findMany({ where: { storageKey: { in: objects.map((o) => o.key) } }, select: { storageKey: true } })).map((r) => r.storageKey));
  let files = 0;
  for (const o of objects) {
    if (known.has(o.key)) continue;
    await storage.delete(o.key).catch(() => {});
    files++;
  }
  return { files };
}
