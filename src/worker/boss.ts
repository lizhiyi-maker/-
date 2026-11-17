import { PgBoss } from "pg-boss";

export const QUEUES = {
  heartbeat: "system.heartbeat",
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
) {
  const boss = createBoss(databaseUrl);
  boss.on("error", (e) => console.error("[pg-boss]", e.message));
  await boss.start();
  await boss.createQueue(QUEUES.heartbeat);
  await boss.work<HeartbeatPayload>(QUEUES.heartbeat, async (jobs) => {
    for (const job of jobs) onHeartbeat(job.data);
  });
  return { boss, stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
