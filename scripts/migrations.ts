import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** 按文件名顺序执行 prisma/migrations 下全部迁移 SQL。 */
export async function applyMigrations(url: string) {
  const root = join(process.cwd(), "prisma", "migrations");
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const d of dirs) await client.query(readFileSync(join(root, d, "migration.sql"), "utf8"));
  } finally {
    await client.end();
  }
}
