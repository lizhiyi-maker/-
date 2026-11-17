import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import type { Tx } from "@/server/people/service";
import { quotaConfig, type QuotaConfig } from "@/server/quota/config";
import type { Quota } from "@/server/quota/ledger";
import type { FileStorage } from "@/server/storage/types";
import { parseChatText } from "@/domain/chat/parser";
import {
  createBatchSchema,
  dataKindSchema,
  editMessageSchema,
  roleSchema,
  type CreateBatchInput,
  type EditMessageInput,
} from "@/domain/imports";
import type { DataKind } from "@/generated/prisma/enums";
import { lockBatch, lockPersonThenBatch, ownedBatch, recomputeOverlap, rolesOf, stageMessages, type LabelRoles, type Role } from "./staging";

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } },
  input: unknown,
): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "输入无效");
  return r.data;
}

export interface ImportsOptions {
  now?: () => Date;
  config?: QuotaConfig;
  /** 截图原图所在的存储；删除批次时一并删除文件 */
  storage?: FileStorage;
  /** 额度账本；删除批次时退还尚未结算的识别额度 */
  quota?: Quota;
}

/**
 * 聊天资料导入服务（M2a：粘贴文本）。流程：建批次 → 提交文本 → 确认“我/对方” → 处理不确定内容 → 保存。
 * 所有方法以 userId 限定范围，访问他人资源与资源不存在表现一致（NotFoundError）。
 * 保存前的消息处于暂存状态，不属于正式聊天资料。规则见 docs/business/import-spec.md。
 */
export function createImports(db: Db, opts: ImportsOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const config = opts.config ?? quotaConfig;

  // ───────── 归属与加锁 ─────────

  async function ownedMessage(client: Db | Tx, userId: string, messageId: string) {
    const m = await client.message.findFirst({ where: { id: messageId, userId } });
    if (!m) throw new NotFoundError("消息");
    return m;
  }

  function assertPending(batch: { status: string }) {
    if (batch.status !== "PENDING_CONFIRM") throw new ValidationError("该批次不在待确认状态");
  }

  // ───────── 批次与提交 ─────────

  async function createBatch(userId: string, personId: string, input: CreateBatchInput) {
    const data = parse(createBatchSchema, input);
    const person = await db.person.findFirst({ where: { id: personId, userId, status: "ACTIVE" }, select: { id: true } });
    if (!person) throw new NotFoundError("对象");
    return db.importBatch.create({ data: { ...data, userId, personId } });
  }

  async function submitText(userId: string, batchId: string, text: string) {
    await ownedBatch(db, userId, batchId);
    if (text.length > config.textPerBatchChars) {
      throw new ValidationError(`粘贴内容超过 ${config.textPerBatchChars} 字，请分批导入`);
    }
    const parsed = parseChatText(text);
    if (parsed.messages.length === 0) throw new ValidationError("没有识别出任何消息，请检查粘贴的内容");

    return db.$transaction(async (tx) => {
      const batch = await lockPersonThenBatch(tx, userId, batchId);
      if (batch.status !== "UPLOADING" || batch.sourceKind !== "TEXT") throw new ValidationError("该批次已经提交过资料");
      const staged = await stageMessages(tx, batch, {
        messages: parsed.messages,
        parserId: parsed.parserId,
        originOf: (m) => ({ kind: "text", line: m.line }),
      });
      return { messages: staged.messages, uncertain: staged.uncertain, labels: parsed.labels };
    });
  }

  // ───────── 预览与可保存性 ─────────

  async function loadPreview(client: Db | Tx, userId: string, batchId: string) {
    const batch = await ownedBatch(client, userId, batchId);
    const rows = await client.message.findMany({
      where: { batchId },
      orderBy: { seq: "asc" },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    const messages = rows.map((m) => ({
      id: m.id,
      seq: m.seq,
      speaker: m.speaker,
      speakerLabel: m.speakerLabel,
      type: m.type,
      content: m.revisions[0]?.content ?? "",
      occurredAt: m.occurredAt,
      timePrecision: m.timePrecision,
      recognition: m.recognition,
      uncertainReason: m.uncertainReason,
      duplicateOfId: m.duplicateOfId,
    }));
    const r = rolesOf(batch);
    const counts = new Map<string, number>();
    for (const m of messages) if (m.speakerLabel) counts.set(m.speakerLabel, (counts.get(m.speakerLabel) ?? 0) + 1);
    const labels = [...counts].map(([label, count]) => ({ label, count, role: (r[label] ?? null) as Role | null }));

    const uncertainCount = messages.filter((m) => m.recognition === "UNCERTAIN").length;
    const overlapCount = messages.filter((m) => m.duplicateOfId !== null).length;
    const blockers: string[] = [];
    if (batch.status !== "PENDING_CONFIRM") {
      blockers.push("该批次当前不能保存");
    } else {
      if (messages.length === 0) blockers.push("没有可保存的消息");
      if (labels.some((l) => l.role === null)) blockers.push("请先确认每个发言人是“我”还是“对方”");
      else if (!batch.identityConfirmedAt) blockers.push("请确认“我/对方”的设置无误");
      if (uncertainCount > 0) blockers.push(`还有 ${uncertainCount} 条不确定的内容需要处理`);
    }
    return {
      batch: {
        id: batch.id,
        personId: batch.personId,
        platform: batch.platform,
        sourceKind: batch.sourceKind,
        dataKind: batch.dataKind,
        status: batch.status,
        identityConfirmed: batch.identityConfirmedAt !== null,
        generation: batch.generation,
        createdAt: batch.createdAt,
        confirmedAt: batch.confirmedAt,
      },
      labels,
      messages,
      uncertainCount,
      overlapCount,
      blockers,
      canConfirm: blockers.length === 0,
    };
  }

  const getPreview = (userId: string, batchId: string) => loadPreview(db, userId, batchId);

  // ───────── 确认“我/对方”、交换 ─────────

  /** 所有发言人都有身份后，视为用户已确认。 */
  async function markIdentityIfComplete(tx: Tx, batchId: string, r: LabelRoles) {
    const labels = await tx.message.findMany({ where: { batchId, speakerLabel: { not: null } }, distinct: ["speakerLabel"], select: { speakerLabel: true } });
    if (labels.length > 0 && labels.every((l) => r[l.speakerLabel!])) {
      await tx.importBatch.update({ where: { id: batchId }, data: { identityConfirmedAt: now() } });
    }
  }

  async function setLabelRole(userId: string, batchId: string, label: string, role: Role) {
    const parsedRole = parse(roleSchema, role);
    await db.$transaction(async (tx) => {
      const batch = await lockBatch(tx, userId, batchId, "UPDATE");
      assertPending(batch);
      if ((await tx.message.count({ where: { batchId, speakerLabel: label } })) === 0) throw new ValidationError(`没有找到发言人“${label}”`);
      const next = { ...rolesOf(batch), [label]: parsedRole };
      await tx.importBatch.update({ where: { id: batchId }, data: { labelRoles: next } });
      await tx.message.updateMany({ where: { batchId, state: "STAGED", speakerLabel: label }, data: { speaker: parsedRole } });
      await markIdentityIfComplete(tx, batchId, next);
      await recomputeOverlap(tx, batch);
    });
  }

  async function confirmIdentity(userId: string, batchId: string) {
    await db.$transaction(async (tx) => {
      const batch = await lockBatch(tx, userId, batchId, "UPDATE");
      assertPending(batch);
      await markIdentityIfComplete(tx, batchId, rolesOf(batch));
      if (!(await ownedBatch(tx, userId, batchId)).identityConfirmedAt) {
        throw new ValidationError("请先确认每个发言人是“我”还是“对方”");
      }
    });
  }

  /** 批内交换“我/对方”。返回受影响的消息数，以及交换前后与已保存资料的重叠条数（便于检查关联影响）。 */
  async function swapSpeakers(userId: string, batchId: string) {
    return db.$transaction(async (tx) => {
      const batch = await lockBatch(tx, userId, batchId, "UPDATE");
      assertPending(batch);
      const roles = rolesOf(batch);
      if (Object.keys(roles).length === 0) throw new ValidationError("请先指定发言人的身份，再交换“我/对方”");
      const overlapBefore = await tx.message.count({ where: { batchId, duplicateOfId: { not: null } } });

      const flipped = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v === "SELF" ? "OTHER" : "SELF"])) as LabelRoles;
      const swappedMessages = await tx.$executeRaw`
        UPDATE "Message"
        SET "speaker" = CASE WHEN "speaker" = 'SELF' THEN 'OTHER'::"Speaker" ELSE 'SELF'::"Speaker" END
        WHERE "batchId" = ${batchId} AND "state" = 'STAGED' AND "speaker" IN ('SELF', 'OTHER')`;
      await tx.importBatch.update({ where: { id: batchId }, data: { labelRoles: flipped } });
      await markIdentityIfComplete(tx, batchId, flipped);
      const overlapAfter = await recomputeOverlap(tx, batch);
      return { swappedMessages, overlapBefore, overlapAfter };
    });
  }

  // ───────── 纠错：编辑、保留、丢弃 ─────────

  async function editMessage(userId: string, messageId: string, input: EditMessageInput) {
    const patch = parse(editMessageSchema, input);
    await db.$transaction(async (tx) => {
      const found = await ownedMessage(tx, userId, messageId);
      const batch = await lockBatch(tx, userId, found.batchId, "SHARE");
      const m = await tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
      });
      const data: Record<string, unknown> = {};

      if (patch.content !== undefined && patch.content !== (m.revisions[0]?.content ?? "")) {
        const revision = m.currentRevision + 1;
        await tx.messageRevision.create({ data: { messageId, revision, content: patch.content } });
        data.currentRevision = revision;
      }
      if (patch.speaker !== undefined && patch.speaker !== m.speaker) data.speaker = patch.speaker;

      if (patch.occurredAt !== undefined || patch.timePrecision !== undefined) {
        let at = patch.occurredAt !== undefined ? patch.occurredAt : m.occurredAt;
        let precision = patch.timePrecision ?? m.timePrecision;
        if (patch.occurredAt === null && patch.timePrecision === undefined) precision = "UNKNOWN";
        if (patch.occurredAt && patch.timePrecision === undefined && (precision === "UNKNOWN" || precision === "ORDER_ONLY")) {
          throw new ValidationError("设置具体时间时，请同时指定时间精度");
        }
        if (precision === "UNKNOWN" || precision === "ORDER_ONLY") at = null;
        else if (!at) throw new ValidationError("该时间精度需要具体的时间");
        if (at?.getTime() !== m.occurredAt?.getTime() || precision !== m.timePrecision) {
          data.occurredAt = at;
          data.timePrecision = precision;
        }
      }

      if (Object.keys(data).length === 0) return;
      data.recognition = "USER_EDITED";
      data.uncertainReason = null;
      await tx.message.update({ where: { id: messageId }, data });
      if (m.state === "STAGED") await recomputeOverlap(tx, batch);
    });
  }

  /** 不确定的内容“按原样保留”：用户已看过并接受，发言人仍保持未知（不猜测）。 */
  async function acceptMessage(userId: string, messageId: string) {
    await db.$transaction(async (tx) => {
      const found = await ownedMessage(tx, userId, messageId);
      await lockBatch(tx, userId, found.batchId, "SHARE");
      if (found.state !== "STAGED") throw new ValidationError("只有待保存的消息可以这样处理");
      await tx.message.update({ where: { id: messageId }, data: { recognition: "RECOGNIZED", uncertainReason: null } });
    });
  }

  async function discardMessage(userId: string, messageId: string) {
    await db.$transaction(async (tx) => {
      const found = await ownedMessage(tx, userId, messageId);
      const batch = await lockBatch(tx, userId, found.batchId, "SHARE");
      if (found.state !== "STAGED") throw new ValidationError("已保存的消息不能单独丢弃，请删除整个批次");
      await tx.message.delete({ where: { id: messageId } });
      await recomputeOverlap(tx, batch);
    });
  }

  async function setDataKind(userId: string, batchId: string, kind: DataKind) {
    const dataKind = parse(dataKindSchema, kind);
    const r = await db.importBatch.updateMany({ where: { id: batchId, userId }, data: { dataKind } });
    if (r.count === 0) throw new NotFoundError("导入批次");
  }

  // ───────── 保存 ─────────

  async function confirm(userId: string, batchId: string, options: { keepOverlap?: boolean } = {}) {
    return db.$transaction(async (tx) => {
      const batch = await lockPersonThenBatch(tx, userId, batchId);
      assertPending(batch);
      await recomputeOverlap(tx, batch);
      const preview = await loadPreview(tx, userId, batchId);
      if (!preview.canConfirm) throw new ValidationError(preview.blockers[0]);

      const duplicates = preview.messages.filter((m) => m.duplicateOfId !== null);
      const merge = !options.keepOverlap && duplicates.length > 0;
      if (merge) {
        if (duplicates.length === preview.messages.length) {
          throw new ValidationError("这批消息都与已保存的聊天重复，无需再保存；如确需保留，请选择“全部保留”");
        }
        await tx.message.deleteMany({ where: { id: { in: duplicates.map((m) => m.id) } } });
      }
      const saved = await tx.message.updateMany({ where: { batchId, state: "STAGED" }, data: { state: "CONFIRMED", duplicateOfId: null } });
      await tx.importBatch.update({ where: { id: batchId }, data: { status: "CONFIRMED", confirmedAt: now() } });
      // 确认是原图的不可逆点（ADR-0003）：立即停止访问，物理文件由清理任务在 24 小时内删除
      await tx.screenshot.updateMany({ where: { batchId, revokedAt: null }, data: { revokedAt: now() } });
      return { saved: saved.count, merged: merge ? duplicates.length : 0 };
    });
  }

  // ───────── 查询 ─────────

  async function listBatches(userId: string, personId: string) {
    const rows = await db.importBatch.findMany({
      where: { userId, personId, status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
      include: { _count: { select: { messages: { where: { state: "CONFIRMED" } } } } },
    });
    return rows.map((b) => ({
      id: b.id,
      platform: b.platform,
      sourceKind: b.sourceKind,
      dataKind: b.dataKind,
      status: b.status,
      confirmedAt: b.confirmedAt,
      messageCount: b._count.messages,
    }));
  }

  /** 尚未保存的批次（首页“待确认”）。 */
  async function listPending(userId: string) {
    const rows = await db.importBatch.findMany({
      where: { userId, status: { not: "CONFIRMED" } },
      orderBy: { createdAt: "desc" },
      include: { person: { select: { nickname: true } }, _count: { select: { messages: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      personId: b.personId,
      nickname: b.person.nickname,
      status: b.status,
      platform: b.platform,
      createdAt: b.createdAt,
      messageCount: b._count.messages,
    }));
  }

  /** 已保存的消息（按原始顺序，内容取当前修订）。 */
  async function listMessages(userId: string, batchId: string) {
    await ownedBatch(db, userId, batchId);
    const rows = await db.message.findMany({
      where: { batchId, userId, state: "CONFIRMED" },
      orderBy: { seq: "asc" },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    return rows.map((m) => ({
      id: m.id,
      seq: m.seq,
      speaker: m.speaker,
      type: m.type,
      content: m.revisions[0]?.content ?? "",
      revision: m.currentRevision,
      occurredAt: m.occurredAt,
      timePrecision: m.timePrecision,
      recognition: m.recognition,
    }));
  }

  async function listRevisions(userId: string, messageId: string) {
    await ownedMessage(db, userId, messageId);
    return db.messageRevision.findMany({ where: { messageId }, orderBy: { revision: "asc" }, select: { revision: true, content: true, createdAt: true } });
  }

  // ───────── 删除与删除围栏 ─────────

  /**
   * 删除批次：先锁行并递增代际，再连同消息、修订与截图记录一并删除；依赖它的重叠标记被清除。
   * 删除后退还尚未结算的识别额度，并删除原图文件（文件删除失败不影响删除结果，会由孤儿文件清理补删）。
   */
  async function deleteBatch(userId: string, batchId: string) {
    const keys = await db.$transaction(async (tx) => {
      await lockBatch(tx, userId, batchId, "UPDATE");
      const shots = await tx.screenshot.findMany({ where: { batchId, purgedAt: null }, select: { storageKey: true } });
      await tx.importBatch.update({ where: { id: batchId }, data: { generation: { increment: 1 } } });
      await tx.importBatch.delete({ where: { id: batchId } });
      return shots.map((x) => x.storageKey);
    });
    await opts.quota?.releaseOpen(userId, "SCREENSHOT", `rec:${batchId}:`, "批次已删除，退还识别额度");
    if (opts.storage) {
      for (const key of keys) {
        try {
          await opts.storage.delete(key);
        } catch {
          // 留给孤儿文件清理
        }
      }
    }
  }

  /** 后台任务写回入口：校验归属、批次仍然存在且代际未变后才执行回调（与删除互斥）。 */
  async function withLiveBatch<T>(userId: string, batchId: string, generation: number, fn: (tx: Tx) => Promise<T>, o: { timeoutMs?: number } = {}): Promise<T> {
    return db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "ImportBatch" WHERE "id" = ${batchId} AND "userId" = ${userId} AND "generation" = ${generation} FOR SHARE`;
        if (rows.length === 0) throw new NotFoundError("导入批次");
        return fn(tx);
      },
      { timeout: o.timeoutMs ?? 30_000 },
    );
  }

  return {
    createBatch,
    submitText,
    getPreview,
    setLabelRole,
    confirmIdentity,
    swapSpeakers,
    editMessage,
    acceptMessage,
    discardMessage,
    setDataKind,
    confirm,
    listBatches,
    listPending,
    listMessages,
    listRevisions,
    deleteBatch,
    withLiveBatch,
  };
}

export type Imports = ReturnType<typeof createImports>;
