import { PgBoss } from "pg-boss";
import { createDb, type Db } from "@/server/db";
import { purgeExpired, purgeStaleBatches } from "@/server/maintenance";

export const QUEUES = {
  heartbeat: "system.heartbeat",
  purgeExpired: "maintenance.purge-expired",
} as const;

export interface HeartbeatPayload {
  requestedAt: string;
}

/** 创建 pg-boss 实例；其内部表由 pg-boss 自行迁移（schema=pgboss），不经 Prisma。 */
export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
}

export async function startWorker(
  databaseUrl: string,
  onHeartbeat: (p: HeartbeatPayload) => void = () => {},
  opts: { db?: Db } = {},
) {
  const db = opts.db ?? createDb(databaseUrl);
  const boss = createBoss(databaseUrl);
  boss.on("error", (e) => console.error("[pg-boss]", e.message));
  await boss.start();
  await boss.createQueue(QUEUES.heartbeat);
  await boss.work<HeartbeatPayload>(QUEUES.heartbeat, async (jobs) => {
    for (const job of jobs) onHeartbeat(job.data);
  });
  // 每小时清理一次过期的验证码、限流记录、会话，以及超过 7 天未保存的导入批次
  await boss.createQueue(QUEUES.purgeExpired);
  await boss.schedule(QUEUES.purgeExpired, "17 * * * *");
  await boss.work(QUEUES.purgeExpired, async () => {
    await purgeExpired(db);
    await purgeStaleBatches(db);
  });
  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      if (!opts.db) await db.$disconnect();
    },
  };
}
