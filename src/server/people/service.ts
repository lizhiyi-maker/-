import { z } from "zod";
import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import {
  accountInputSchema,
  feelingSchema,
  personInputSchema,
  personPatchSchema,
  type AccountInput,
  type GenderFilter,
  type PersonInput,
  type PersonPatch,
} from "@/domain/people";
import type { Feeling } from "@/generated/prisma/enums";

export { NotFoundError, ValidationError };

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "输入无效");
  return r.data;
}

/**
 * 对象服务。所有方法的第一个参数都是 userId，并且每条查询都以 userId 限定范围；
 * 访问不属于该用户的对象与访问不存在的对象表现一致（NotFoundError），不泄露其存在。
 */
export function createPeople(db: Db) {
  async function owned(client: Db | Tx, userId: string, personId: string) {
    const p = await client.person.findFirst({ where: { id: personId, userId, status: "ACTIVE" } });
    if (!p) throw new NotFoundError("对象");
    return p;
  }

  async function create(userId: string, input: PersonInput) {
    const data = parse(personInputSchema, input);
    return db.person.create({ data: { ...data, userId } });
  }

  async function list(userId: string, filter: GenderFilter) {
    const rows = await db.person.findMany({
      where: { userId, status: "ACTIVE", ...(filter === "ALL" ? {} : { gender: filter }) },
      orderBy: { updatedAt: "desc" },
      include: { feelings: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    return rows.map(({ feelings, ...p }) => ({ ...p, feeling: (feelings[0]?.value ?? null) as Feeling | null }));
  }

  async function get(userId: string, personId: string) {
    const p = await db.person.findFirst({
      where: { id: personId, userId, status: "ACTIVE" },
      include: {
        accounts: { orderBy: { confirmedAt: "asc" } },
        feelings: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!p) throw new NotFoundError("对象");
    const { feelings, ...rest } = p;
    return { ...rest, feeling: feelings[0] ?? null, feelingHistory: feelings };
  }

  async function update(userId: string, personId: string, patch: PersonPatch) {
    const data = parse(personPatchSchema, patch);
    await owned(db, userId, personId);
    return db.person.update({ where: { id: personId }, data });
  }

  async function addAccount(userId: string, personId: string, input: AccountInput) {
    const data = parse(accountInputSchema, input);
    await owned(db, userId, personId);
    const exists = await db.platformAccount.findFirst({ where: { personId, platform: data.platform, handle: data.handle } });
    if (exists) throw new ValidationError("该平台账号已关联到此对象");
    // 由用户主动确认关联；不会按昵称相同自动合并不同对象。
    return db.platformAccount.create({ data: { ...data, personId, userId } });
  }

  async function removeAccount(userId: string, personId: string, accountId: string) {
    await owned(db, userId, personId);
    const r = await db.platformAccount.deleteMany({ where: { id: accountId, personId, userId } });
    if (r.count === 0) throw new NotFoundError("平台账号");
  }

  async function setFeeling(userId: string, personId: string, value: Feeling) {
    const v = parse(feelingSchema, value);
    await owned(db, userId, personId);
    return db.feelingEntry.create({ data: { personId, userId, value: v } });
  }

  /**
   * 删除围栏：先锁行并递增代际，再删除对象及其派生数据。
   * 与 withLivePerson 的共享锁互斥，因此任务写回要么在删除前完整提交，要么被拒绝。
   */
  async function remove(userId: string, personId: string) {
    await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Person" WHERE "id" = ${personId} AND "userId" = ${userId} AND "status" = 'ACTIVE' FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("对象");
      await tx.person.update({ where: { id: personId }, data: { status: "DELETING", generation: { increment: 1 } } });
      await tx.person.delete({ where: { id: personId } });
    });
  }

  /**
   * 后台任务写回入口：在事务内对对象行加共享锁，校验归属、未被删除且代际未变，
   * 然后才执行写回回调。校验失败时回调不会运行。
   */
  async function withLivePerson<T>(
    userId: string,
    personId: string,
    generation: number,
    fn: (tx: Tx) => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Person"
          WHERE "id" = ${personId} AND "userId" = ${userId} AND "status" = 'ACTIVE' AND "generation" = ${generation}
          FOR SHARE`;
        if (rows.length === 0) throw new NotFoundError("对象");
        return fn(tx);
      },
      { timeout: opts.timeoutMs ?? 30_000 },
    );
  }

  return { create, list, get, update, addAccount, removeAccount, setFeeling, remove, withLivePerson };
}

export type People = ReturnType<typeof createPeople>;
