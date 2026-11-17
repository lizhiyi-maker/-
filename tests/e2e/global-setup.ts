import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedPg } from "../../scripts/embedded-pg";
import { applyMigrations } from "../../scripts/migrations";

export const E2E_DB_PORT = 54331;

/** e2e 使用独立的临时 PostgreSQL，并应用全部迁移；结束后清理。 */
export default async function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), "rel-e2e-pg-"));
  const db = await startEmbeddedPg({ dir, port: E2E_DB_PORT, database: "e2e", persistent: true });
  await applyMigrations(db.url);
  return async () => {
    await db.stop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Windows 下句柄释放有延迟，临时目录由系统清理
    }
  };
}
