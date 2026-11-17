import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface EmbeddedDb {
  url: string;
  stop: () => Promise<void>;
}

/** 启动一个 embedded-postgres 实例（仅用于本地开发与自动化测试，无需 Docker）。 */
export async function startEmbeddedPg(opts: {
  dir: string;
  port: number;
  database: string;
  persistent?: boolean;
}): Promise<EmbeddedDb> {
  const user = "postgres";
  const password = "postgres";
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user,
    password,
    port: opts.port,
    persistent: opts.persistent ?? true,
    onLog: () => {},
    onError: (e) => console.error("[embedded-postgres]", e),
  });
  if (!existsSync(join(opts.dir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase(opts.database);
  } catch {
    // 已存在
  }
  return {
    url: `postgresql://${user}:${password}@127.0.0.1:${opts.port}/${opts.database}`,
    stop: () => pg.stop(),
  };
}
