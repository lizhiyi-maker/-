import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedPg, type EmbeddedDb } from "../../scripts/embedded-pg";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** 为集成测试启动隔离的临时 PostgreSQL；stop() 同时清理数据目录。 */
export async function startTestDb(): Promise<EmbeddedDb> {
  const dir = mkdtempSync(join(tmpdir(), "rel-test-pg-"));
  const db = await startEmbeddedPg({ dir, port: await freePort(), database: "test", persistent: false });
  return {
    url: db.url,
    stop: async () => {
      await db.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
