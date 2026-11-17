import { PgBoss } from "pg-boss";
import { QUEUES } from "@/worker/queues";
import type { JobQueue, RecognitionJob } from "@/server/recognition/service";

/**
 * 基于 pg-boss 的任务入队（Web 进程使用，任务由独立 worker 执行）。
 * 惰性启动：第一次入队时才连接；pg-boss 的内部表（schema pgboss）由它自己迁移。
 * 不使用 pg-boss 的自动重试：识别任务按“认领”语义保证只执行一次，卡住的任务由 sweepStuck 判为失败并退还额度。
 */
export function createPgBossQueue(databaseUrl: string): JobQueue & { stop: () => Promise<void> } {
  let started: Promise<PgBoss> | undefined;
  const boss = () =>
    (started ??= (async () => {
      const b = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
      b.on("error", (e) => console.error("[pg-boss]", e.message));
      await b.start();
      await b.createQueue(QUEUES.recognition);
      return b;
    })());

  return {
    async enqueue(job: RecognitionJob) {
      await (await boss()).send(QUEUES.recognition, job, { retryLimit: 0, expireInSeconds: 15 * 60 });
    },
    async stop() {
      if (started) await (await started).stop({ graceful: true, timeout: 5000 });
    },
  };
}
