import { getEnv } from "@/lib/env";
import { startWorker } from "./boss";

const env = getEnv(); // 与 Web 进程同一套校验：生产环境启用演示开关会拒绝启动
const worker = await startWorker(env.DATABASE_URL);
console.log("worker 已启动");

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
