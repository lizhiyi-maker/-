import { getServices } from "@/server/container";
import { startWorker } from "./boss";

// 与 Web 进程共用同一套装配与环境校验：生产环境启用演示开关会拒绝启动
const { env, db, recognition, analysis, storage, account } = getServices();

/** 数据库可能比 worker 晚就绪（容器同时启动、数据库重启）：启动失败时重试，而不是直接退出。 */
async function startWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startWorker(env.DATABASE_URL, undefined, { db, recognition, analysis, storage, account });
    } catch (e) {
      if (attempt >= 60) throw e;
      console.error(`worker 启动失败（${e instanceof Error ? e.name : "unknown"}），2 秒后重试 ${attempt}/60`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const worker = await startWithRetry();
console.log("worker 已启动");

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
