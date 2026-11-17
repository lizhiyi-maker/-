import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { startEmbeddedPg } from "../../scripts/embedded-pg";
import { applyMigrations } from "../../scripts/migrations";

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

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/** 整个测试进程共用一个 PostgreSQL；迁移只执行一次到模板库，每个测试文件克隆自己的库。 */
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "rel-test-pg-"));
  const db = await startEmbeddedPg({ dir, port: await freePort(), database: "template_base", persistent: true });
  await applyMigrations(db.url);
  project.provide("pgAdminUrl", db.url.replace(/\/template_base$/, "/postgres"));
  return async () => {
    await db.stop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Windows 下文件句柄释放有延迟；临时目录由系统清理
    }
  };
}
