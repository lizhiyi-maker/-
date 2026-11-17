import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedPg } from "./embedded-pg";
import { applyMigrations } from "./migrations";

/** Playwright 的 e2e 数据库：临时 PostgreSQL + 全部迁移。作为第一个 webServer 启动，早于 Web 与 worker。 */
const port = Number(process.env.E2E_DB_PORT ?? 54331);
const db = await startEmbeddedPg({ dir: mkdtempSync(join(tmpdir(), "rel-e2e-pg-")), port, database: "e2e", persistent: true });
await applyMigrations(db.url);
console.log("E2E DB READY");

const shutdown = async () => {
  await db.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30);
