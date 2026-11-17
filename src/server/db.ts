import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForDb = globalThis as unknown as { __db?: Db };

/** 进程内单例（开发热重载下复用）。 */
export function getDb(): Db {
  return (globalForDb.__db ??= createDb(process.env.DATABASE_URL!));
}
