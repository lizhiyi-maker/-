import { z } from "zod";
import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import { lockLivePerson, type Tx } from "@/server/people/service";
import { eventInputSchema, eventPatchSchema, parseEventDate, todayInBeijing, type EventInput, type EventKind, type EventPatch } from "@/domain/events";

export interface EventView {
  id: string;
  personId: string;
  kind: EventKind;
  occurredOn: Date;
  /** 事实：可被报告引用，修改会产生新修订 */
  facts: string;
  /** 用户自己的个人感受：不是证据，不发送给 AI 服务商 */
  personalNote: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "输入无效");
  return r.data;
}

/**
 * 线下事件服务。事实（类型、日期、经过）与个人感受分开保存：事实每次改动留下新修订（同消息修订，见 ADR-0002），
 * 个人感受只在事件行上、随时可改且不产生修订。所有方法以 userId 限定范围，访问不属于自己的事件与不存在的表现一致。
 * 写入都在对象的共享锁内进行，与对象删除（FOR UPDATE）互斥。
 */
export function createEvents(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());

  function assertNotFuture(occurredOn: string) {
    if (occurredOn > todayInBeijing(now())) throw new ValidationError("事件日期不能晚于今天；这里只记录已经发生的事");
  }

  const view = (row: { id: string; personId: string; kind: EventKind; occurredOn: Date; personalNote: string | null; currentRevision: number; createdAt: Date; updatedAt: Date }, facts: string): EventView => ({
    id: row.id,
    personId: row.personId,
    kind: row.kind,
    occurredOn: row.occurredOn,
    facts,
    personalNote: row.personalNote,
    revision: row.currentRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  async function ownedPerson(client: Db | Tx, userId: string, personId: string) {
    const p = await client.person.findFirst({ where: { id: personId, userId, status: "ACTIVE" }, select: { id: true } });
    if (!p) throw new NotFoundError("对象");
  }

  async function create(userId: string, personId: string, input: EventInput): Promise<EventView> {
    const data = parse(eventInputSchema, input);
    assertNotFuture(data.occurredOn);
    return db.$transaction(async (tx) => {
      await lockLivePerson(tx, userId, personId);
      const row = await tx.offlineEvent.create({
        data: { userId, personId, kind: data.kind, occurredOn: parseEventDate(data.occurredOn)!, personalNote: data.personalNote ?? null },
      });
      await tx.offlineEventRevision.create({ data: { eventId: row.id, revision: 1, kind: data.kind, occurredOn: row.occurredOn, facts: data.facts } });
      return view(row, data.facts);
    });
  }

  async function update(userId: string, eventId: string, patch: EventPatch): Promise<EventView> {
    const data = parse(eventPatchSchema, patch);
    if (data.occurredOn !== undefined) assertNotFuture(data.occurredOn);
    return db.$transaction(async (tx) => {
      const found = await tx.offlineEvent.findFirst({ where: { id: eventId, userId }, select: { personId: true } });
      if (!found) throw new NotFoundError("线下事件");
      await lockLivePerson(tx, userId, found.personId);
      // 行锁：并发修改同一事件时按顺序产生修订号
      await tx.$queryRaw`SELECT "id" FROM "OfflineEvent" WHERE "id" = ${eventId} FOR UPDATE`;
      const row = await tx.offlineEvent.findUnique({ where: { id: eventId }, include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } });
      if (!row) throw new NotFoundError("线下事件");
      const latest = row.revisions[0];

      const kind = data.kind ?? row.kind;
      const occurredOn = data.occurredOn !== undefined ? parseEventDate(data.occurredOn)! : row.occurredOn;
      const facts = data.facts ?? latest.facts;
      const factsChanged = kind !== row.kind || occurredOn.getTime() !== row.occurredOn.getTime() || facts !== latest.facts;
      const noteChanged = data.personalNote !== undefined && (data.personalNote ?? null) !== row.personalNote;
      if (!factsChanged && !noteChanged) return view(row, latest.facts);

      const revision = factsChanged ? row.currentRevision + 1 : row.currentRevision;
      if (factsChanged) await tx.offlineEventRevision.create({ data: { eventId, revision, kind, occurredOn, facts } });
      const updated = await tx.offlineEvent.update({
        where: { id: eventId },
        data: { kind, occurredOn, currentRevision: revision, ...(noteChanged ? { personalNote: data.personalNote ?? null } : {}) },
      });
      return view(updated, facts);
    });
  }

  async function remove(userId: string, eventId: string): Promise<void> {
    await db.$transaction(async (tx) => {
      const found = await tx.offlineEvent.findFirst({ where: { id: eventId, userId }, select: { personId: true } });
      if (!found) throw new NotFoundError("线下事件");
      await lockLivePerson(tx, userId, found.personId);
      await tx.offlineEvent.delete({ where: { id: eventId } }); // 修订随之级联删除
    });
  }

  /** 某对象的全部事件，按事件日期从新到旧。 */
  async function list(userId: string, personId: string): Promise<EventView[]> {
    await ownedPerson(db, userId, personId);
    const rows = await db.offlineEvent.findMany({
      where: { userId, personId },
      orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    return rows.map((r) => view(r, r.revisions[0]?.facts ?? ""));
  }

  return { create, update, remove, list };
}

export type Events = ReturnType<typeof createEvents>;
