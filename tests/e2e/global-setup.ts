import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 每次运行前清空上传目录（Web 与 worker 共用的本地存储，位于仓库之外）；数据库由 playwright.config 的第一个 webServer 提供。 */
export default async function globalSetup() {
  const uploads = join(tmpdir(), "rel-e2e-uploads");
  rmSync(uploads, { recursive: true, force: true });
  mkdirSync(uploads, { recursive: true });
  return async () => {
    rmSync(uploads, { recursive: true, force: true });
  };
}
