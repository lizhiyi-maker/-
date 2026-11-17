import pg from "pg";
import { inject } from "vitest";
import { createDb, type Db } from "@/server/db";

let counter = 0;

/** 为一个测试文件克隆一个已应用全部迁移的独立数据库。 */
export async function newTestDb(): Promise<{ db: Db; url: string; close: () => Promise<void> }> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template_base`);
  await admin.end();
  const url = adminUrl.replace(/\/postgres$/, `/${name}`);
  const db = createDb(url);
  return {
    db,
    url,
    close: async () => {
      await db.$disconnect();
    },
  };
}
