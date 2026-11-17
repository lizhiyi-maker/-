import { PgBoss } from "pg-boss";
import { QUEUES } from "./queues";
import { createDb, type Db } from "@/server/db";
import { purgeExpired, purgeOrphanFiles, purgeRevokedOriginals, purgeStaleBatches } from "@/server/maintenance";
import type { Recognition, RecognitionJob } from "@/server/recognition/service";
import type { FileStorage } from "@/server/storage/types";

export { QUEUES };

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
  opts: { db?: Db; recognition?: Recognition; storage?: FileStorage } = {},
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
    await purgeStaleBatches(db, new Date(), opts.storage);
    if (opts.storage) {
      // 确认保存后的原图在 24 小时内物理删除（每小时执行）；顺带清理孤儿文件
      await purgeRevokedOriginals(db, opts.storage);
      await purgeOrphanFiles(db, opts.storage);
    }
  });

  if (opts.recognition) {
    const recognition = opts.recognition;
    await boss.createQueue(QUEUES.recognition);
    await boss.work<RecognitionJob>(QUEUES.recognition, async (jobs) => {
      for (const job of jobs) await recognition.processScreenshot(job.data);
    });
    // 每 5 分钟把卡住的识别任务判为失败并退还额度
    await boss.createQueue(QUEUES.sweepRecognition);
    await boss.schedule(QUEUES.sweepRecognition, "*/5 * * * *");
    await boss.work(QUEUES.sweepRecognition, async () => {
      await recognition.sweepStuck();
    });
  }
  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      if (!opts.db) await db.$disconnect();
    },
  };
}
