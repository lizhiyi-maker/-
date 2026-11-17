import { resolve } from "node:path";
import { startEmbeddedPg } from "./embedded-pg";

const port = Number(process.env.DEV_DB_PORT ?? 54329);
const db = await startEmbeddedPg({ dir: resolve(".data/pg"), port, database: "relationship" });
console.log(`开发数据库已启动：${db.url}`);
console.log("按 Ctrl+C 停止。数据保存在 .data/pg。");

const shutdown = async () => {
  await db.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30);
