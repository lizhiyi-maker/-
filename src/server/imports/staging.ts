import { randomUUID } from "node:crypto";
import { lockLivePerson, type Tx } from "@/server/people/service";
import type { Db } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { findOverlaps, type KeyMessage } from "@/domain/chat/overlap";
import type { ParsedMessage } from "@/domain/chat/types";
import type { Speaker } from "@/generated/prisma/enums";

export type Role = "SELF" | "OTHER";
export type LabelRoles = Record<string, Role>;

export const rolesOf = (b: { labelRoles: unknown }) => (b.labelRoles ?? {}) as LabelRoles;

export async function ownedBatch(client: Db | Tx, userId: string, batchId: string) {
  const b = await client.importBatch.findFirst({ where: { id: batchId, userId } });
  if (!b) throw new NotFoundError("导入批次");
  return b;
}

/** 锁定批次行（归属校验在 SQL 内）：改变批次的操作用 UPDATE，编辑类用 SHARE；都与删除互斥。 */
export async function lockBatch(tx: Tx, userId: string, batchId: string, mode: "UPDATE" | "SHARE") {
  const rows =
    mode === "UPDATE"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ImportBatch" WHERE "id" = ${batchId} AND "userId" = ${userId} FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ImportBatch" WHERE "id" = ${batchId} AND "userId" = ${userId} FOR SHARE`;
  if (rows.length === 0) throw new NotFoundError("导入批次");
  return ownedBatch(tx, userId, batchId);
}

/**
 * 重新计算暂存消息与同一对象已保存消息的重叠，返回重叠条数。
 * 发言人未确认的消息不参与（不可能被判定为同一条）。
 */
export async function recomputeOverlap(tx: Tx, batch: { id: string; userId: string; personId: string }): Promise<number> {
  const latest = { revisions: { orderBy: { revision: "desc" as const }, take: 1 } };
  const staged = await tx.message.findMany({ where: { batchId: batch.id, state: "STAGED" }, orderBy: { seq: "asc" }, include: latest });
  const existing = await tx.message.findMany({
    where: { userId: batch.userId, personId: batch.personId, state: "CONFIRMED" },
    orderBy: [{ batch: { confirmedAt: "asc" } }, { seq: "asc" }],
    include: latest,
  });
  // 发言人未知的消息用唯一内容占位，保证不与任何消息相同，同时保持相邻关系
  const key = (m: (typeof staged)[number]): KeyMessage => ({
    speaker: m.speaker,
    content: m.speaker === "UNKNOWN" ? `\u0000${m.id}` : (m.revisions[0]?.content ?? ""),
    occurredAt: m.occurredAt,
    timePrecision: m.timePrecision,
  });
  const overlaps = findOverlaps(existing.map(key), staged.map(key));

  let count = 0;
  for (const [i, m] of staged.entries()) {
    const target = overlaps.has(i) ? existing[overlaps.get(i)!].id : null;
    if (target) count++;
    if (m.duplicateOfId !== target) await tx.message.update({ where: { id: m.id }, data: { duplicateOfId: target } });
  }
  return count;
}

/**
 * 写入类操作统一的加锁顺序：先对象（共享锁），再批次（排他锁）。
 * 与“删除对象”（先锁对象再级联删除批次）顺序一致，避免死锁；同时保证对象或批次已删除时失败。
 */
export async function lockPersonThenBatch(tx: Tx, userId: string, batchId: string) {
  const unlocked = await ownedBatch(tx, userId, batchId);
  await lockLivePerson(tx, userId, unlocked.personId);
  return lockBatch(tx, userId, batchId, "UPDATE");
}

export interface StageInput {
  messages: ParsedMessage[];
  parserId: string;
  /** 每条消息的原始出处（文本：行号；截图：第几张及其中的序号） */
  originOf: (m: ParsedMessage, index: number) => Record<string, unknown>;
}

/**
 * 把解析/识别出的消息写成暂存消息，批次进入“待确认”。
 * 按同一对象、同一平台上次保存的设置预填“我/对方”，但仍需用户确认后才能保存。
 */
export async function stageMessages(tx: Tx, batch: { id: string; userId: string; personId: string; platform: "WECHAT" | "DOUYIN" | "OTHER" }, input: StageInput) {
  const previous = await tx.importBatch.findFirst({
    where: { userId: batch.userId, personId: batch.personId, platform: batch.platform, status: "CONFIRMED", identityConfirmedAt: { not: null }, id: { not: batch.id } },
    orderBy: { confirmedAt: "desc" },
  });
  const labels = [...new Set(input.messages.map((m) => m.speakerLabel).filter((l): l is string => l !== null))];
  const prefilled: LabelRoles = {};
  for (const label of labels) {
    const r = previous ? rolesOf(previous)[label] : undefined;
    if (r) prefilled[label] = r;
  }

  const rows = input.messages.map((m, seq) => ({ id: randomUUID(), seq, m }));
  await tx.message.createMany({
    data: rows.map(({ id, seq, m }) => ({
      id,
      userId: batch.userId,
      personId: batch.personId,
      batchId: batch.id,
      seq,
      speaker: (m.speakerLabel ? (prefilled[m.speakerLabel] ?? "UNKNOWN") : "UNKNOWN") as Speaker,
      speakerLabel: m.speakerLabel,
      type: m.type,
      occurredAt: m.occurredAt,
      timePrecision: m.timePrecision,
      origin: input.originOf(m, seq) as never,
      recognition: m.uncertain ? ("UNCERTAIN" as const) : ("RECOGNIZED" as const),
      uncertainReason: m.reason ?? null,
    })),
  });
  await tx.messageRevision.createMany({ data: rows.map(({ id, m }) => ({ messageId: id, revision: 1, content: m.content })) });
  await tx.importBatch.update({ where: { id: batch.id }, data: { status: "PENDING_CONFIRM", parserId: input.parserId, labelRoles: prefilled } });
  if (Object.keys(prefilled).length > 0) await recomputeOverlap(tx, batch);
  return { messages: input.messages.length, uncertain: input.messages.filter((m) => m.uncertain).length, labels };
}
