import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import type { Tx } from "@/server/people/service";
import { quotaConfig, type QuotaConfig } from "@/server/quota/config";
import { QuotaError, type Quota } from "@/server/quota/ledger";
import type { FileStorage } from "@/server/storage/types";
import type { VisionModel } from "@/server/ai/vision";
import { sniffImageType } from "@/domain/chat/image-type";
import { findOverlaps, type KeyMessage } from "@/domain/chat/overlap";
import type { ParsedMessage } from "@/domain/chat/types";
import { Prisma } from "@/generated/prisma/client";
import { lockPersonThenBatch, ownedBatch, stageMessages } from "@/server/imports/staging";

export interface RecognitionJob {
  screenshotId: string;
  round: number;
  /** 提交时批次的代际；批次被删除后代际变化或记录消失，任务不能写回 */
  generation: number;
}

export interface JobQueue {
  enqueue(job: RecognitionJob): Promise<void>;
}

export interface RecognitionDeps {
  storage: FileStorage;
  quota: Quota;
  vision: VisionModel;
  queue: JobQueue;
  now?: () => Date;
  config?: QuotaConfig;
}

export const SIGNED_URL_TTL_SECONDS = 300;
const STUCK_AFTER_MS = 15 * 60_000;
const OVERLAP_WINDOW = 60;
export const VISION_PARSER_ID = "vision-v1";

const PENDING = ["QUEUED", "RUNNING"] as const;

export type AddResult = { status: "added"; id: string; idx: number } | { status: "duplicate"; name: string };

/** 识别结果在数据库里是 JSON，日期需要还原。 */
function reviveMessages(json: unknown): ParsedMessage[] {
  const arr = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
  return arr.map((m) => ({
    line: Number(m.line),
    speakerLabel: (m.speakerLabel as string | null) ?? null,
    content: String(m.content ?? ""),
    type: m.type as ParsedMessage["type"],
    occurredAt: m.occurredAt ? new Date(m.occurredAt as string) : null,
    timePrecision: m.timePrecision as ParsedMessage["timePrecision"],
    uncertain: Boolean(m.uncertain),
    reason: (m.reason as string | undefined) ?? undefined,
  }));
}

/**
 * 截图导入与识别服务（M2b）。流程：上传（只存原图，不消耗额度）→ 用户点“开始识别”（按张预留额度并入队）
 * → worker 逐张识别 → 全部结束后整合为暂存消息 → 复用 M2a 的确认流程。
 * 识别额度以“轮”为单位：每次开始/重试预留本轮的张数，本轮结束后按成功张数结算、其余退还。
 */
export function createRecognition(db: Db, deps: RecognitionDeps) {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? quotaConfig;
  const { storage, quota, vision, queue } = deps;

  const roundKey = (batchId: string, round: number) => `rec:${batchId}:${round}`;

  // ───────── 上传 ─────────

  async function addScreenshot(userId: string, batchId: string, file: { name: string; bytes: Uint8Array }): Promise<AddResult> {
    await ownedBatch(db, userId, batchId);
    if (file.bytes.length === 0) throw new ValidationError("文件是空的");
    if (file.bytes.length > config.screenshot.maxBytes) {
      throw new ValidationError(`单张图片不能超过 ${Math.floor(config.screenshot.maxBytes / 1_000_000)} MB`);
    }
    const contentType = sniffImageType(file.bytes);
    if (!contentType) throw new ValidationError("只支持 PNG、JPEG、WebP 格式的图片");
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");

    return db.$transaction(async (tx) => {
      const batch = await lockPersonThenBatch(tx, userId, batchId);
      if (batch.sourceKind !== "SCREENSHOT") throw new ValidationError("这是文本导入的批次，不能上传截图");
      if (batch.status !== "UPLOADING") throw new ValidationError("已经开始识别，不能再添加截图");

      const existingCount = await tx.screenshot.count({ where: { batchId } });
      if (existingCount >= config.screenshot.perBatch) throw new ValidationError(`单批最多 ${config.screenshot.perBatch} 张截图，请分批导入`);

      // 同一对象的全部批次（包含已保存、原图已删除的）都检查，避免累计同一段聊天
      const dup = await tx.screenshot.findFirst({ where: { userId, personId: batch.personId, sha256 }, select: { id: true } });
      if (dup) return { status: "duplicate" as const, name: file.name };

      const id = randomUUID();
      const storageKey = `u/${userId}/${batchId}/${id}`;
      await storage.put(storageKey, file.bytes, contentType);
      try {
        const last = await tx.screenshot.aggregate({ where: { batchId }, _max: { idx: true } });
        const idx = (last._max.idx ?? -1) + 1;
        await tx.screenshot.create({
          data: { id, userId, personId: batch.personId, batchId, idx, sha256, contentType, sizeBytes: file.bytes.length, storageKey },
        });
        return { status: "added" as const, id, idx };
      } catch (e) {
        await storage.delete(storageKey).catch(() => {});
        throw e;
      }
    });
  }

  async function removeScreenshot(userId: string, screenshotId: string) {
    const shot = await db.screenshot.findFirst({ where: { id: screenshotId, userId } });
    if (!shot) throw new NotFoundError("截图");
    await db.$transaction(async (tx) => {
      const batch = await lockPersonThenBatch(tx, userId, shot.batchId);
      if (batch.status !== "UPLOADING") throw new ValidationError("已经开始识别，不能移除截图");
      await tx.screenshot.delete({ where: { id: screenshotId } });
    });
    await storage.delete(shot.storageKey).catch(() => {});
  }

  async function list(userId: string, batchId: string) {
    await ownedBatch(db, userId, batchId);
    const rows = await db.screenshot.findMany({ where: { batchId, userId }, orderBy: { idx: "asc" } });
    return rows.map((s) => ({
      id: s.id,
      idx: s.idx,
      status: s.status,
      errorCode: s.errorCode,
      contentType: s.contentType,
      sizeBytes: s.sizeBytes,
      attempts: s.attempts,
      /** 确认保存后原图停止访问 */
      available: s.revokedAt === null && s.purgedAt === null,
    }));
  }

  async function getProgress(userId: string, batchId: string) {
    const batch = await ownedBatch(db, userId, batchId);
    const groups = await db.screenshot.groupBy({ by: ["status"], where: { batchId }, _count: { _all: true } });
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const counts = { uploaded: n("UPLOADED"), queued: n("QUEUED"), running: n("RUNNING"), done: n("DONE"), failed: n("FAILED"), skipped: n("SKIPPED") };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const inFlight = counts.queued + counts.running;
    const recognizing = batch.status === "RECOGNIZING";
    return {
      status: batch.status,
      sourceKind: batch.sourceKind,
      total,
      ...counts,
      /** 没有排队或运行中的任务（可能仍有失败项等待用户处理） */
      finished: inFlight === 0,
      canStart: batch.status === "UPLOADING" && counts.uploaded > 0,
      canRetry: recognizing && inFlight === 0 && counts.failed > 0,
      canSkip: recognizing && inFlight === 0 && counts.failed > 0 && counts.done > 0,
    };
  }

  // ───────── 提交识别：开始 / 重试失败项 ─────────

  async function submitRound(userId: string, batchId: string, mode: "start" | "retry") {
    const batch = await ownedBatch(db, userId, batchId);
    const target = mode === "start" ? "UPLOADED" : "FAILED";
    if (mode === "start" && batch.status !== "UPLOADING") throw new ValidationError("这批截图已经提交过识别");
    if (mode === "retry" && batch.status !== "RECOGNIZING") throw new ValidationError("没有可以重试的截图");
    const count = await db.screenshot.count({ where: { batchId, status: target } });
    if (count === 0) throw new ValidationError(mode === "start" ? "请先上传截图" : "没有识别失败的截图");

    const round = batch.recRound + 1;
    const key = roundKey(batchId, round);
    await quota.reserve(userId, "SCREENSHOT", count, key); // 额度不足时抛出 InsufficientQuotaError，状态不变

    let ids: string[];
    let generation: number;
    try {
      ({ ids, generation } = await db.$transaction(async (tx) => {
        const b = await lockPersonThenBatch(tx, userId, batchId);
        if (b.recRound !== batch.recRound || b.status !== batch.status) throw new ValidationError("状态已经变化，请刷新后重试");
        if ((await tx.screenshot.count({ where: { batchId, status: { in: [...PENDING] } } })) > 0) throw new ValidationError("还有截图正在识别");
        const rows = await tx.screenshot.findMany({ where: { batchId, status: target }, orderBy: { idx: "asc" }, select: { id: true } });
        if (rows.length !== count) throw new ValidationError("截图状态已经变化，请刷新后重试");
        await tx.screenshot.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { status: "QUEUED", round, queuedAt: now(), errorCode: null, finishedAt: null },
        });
        await tx.importBatch.update({ where: { id: batchId }, data: { status: "RECOGNIZING", recRound: round } });
        return { ids: rows.map((r) => r.id), generation: b.generation };
      }));
    } catch (e) {
      await quota.release(userId, "SCREENSHOT", key).catch(() => {});
      throw e;
    }

    for (const id of ids) {
      try {
        await queue.enqueue({ screenshotId: id, round, generation });
      } catch {
        // 入队失败：立即判为失败（不扣额度），用户可重试
        await finishScreenshot({ screenshotId: id, round, generation }, { ok: false, code: "QUEUE_FAILED" }, "QUEUED");
      }
    }
    return { queued: ids.length };
  }

  const start = (userId: string, batchId: string) => submitRound(userId, batchId, "start");
  const retryFailed = (userId: string, batchId: string) => submitRound(userId, batchId, "retry");

  // ───────── 整合 ─────────

  /** 按上传顺序把各张截图的识别结果整合为暂存消息；相邻截图之间重叠的部分只保留一份。 */
  async function stageFromScreenshots(tx: Tx, batch: { id: string; userId: string; personId: string; platform: "WECHAT" | "DOUYIN" | "OTHER" }) {
    const shots = await tx.screenshot.findMany({ where: { batchId: batch.id, status: "DONE" }, orderBy: { idx: "asc" } });
    const kept: { m: ParsedMessage; origin: Record<string, unknown> }[] = [];
    const identity = new Map<string, "SELF" | "OTHER">();
    const key = (m: ParsedMessage, uniq: string): KeyMessage => {
      let speaker: KeyMessage["speaker"] = "UNKNOWN";
      if (m.speakerLabel) {
        if (!identity.has(m.speakerLabel) && identity.size < 2) identity.set(m.speakerLabel, identity.size === 0 ? "SELF" : "OTHER");
        speaker = identity.get(m.speakerLabel) ?? "UNKNOWN";
      }
      // 无法归属的消息用唯一内容占位，保证不被当作重叠
      return { speaker, content: speaker === "UNKNOWN" ? `\u0000${uniq}` : m.content, occurredAt: m.occurredAt, timePrecision: m.timePrecision };
    };

    for (const shot of shots) {
      const msgs = reviveMessages(shot.result);
      const tail = kept.slice(-OVERLAP_WINDOW);
      const overlaps = findOverlaps(
        tail.map((t, i) => key(t.m, `t${kept.length - tail.length + i}`)),
        msgs.map((m, i) => key(m, `s${shot.idx}:${i}`)),
      );
      msgs.forEach((m, i) => {
        if (!overlaps.has(i)) kept.push({ m, origin: { kind: "image", index: shot.idx, line: m.line } });
      });
    }
    await stageMessages(tx, batch, { messages: kept.map((k) => k.m), parserId: VISION_PARSER_ID, originOf: (_m, i) => kept[i].origin });
    await tx.screenshot.updateMany({ where: { batchId: batch.id, status: "DONE" }, data: { result: Prisma.JsonNull } });
  }

  /** 没有排队或运行中的截图、也没有失败项等待处理时，整合结果并进入“待确认”。 */
  async function stageIfReady(tx: Tx, batch: { id: string; userId: string; personId: string; platform: "WECHAT" | "DOUYIN" | "OTHER"; status: string }) {
    if (batch.status !== "RECOGNIZING") return;
    const open = await tx.screenshot.count({ where: { batchId: batch.id, status: { in: [...PENDING, "FAILED"] } } });
    if (open === 0) await stageFromScreenshots(tx, batch);
  }

  /** 本轮没有未完成的截图后，按成功张数结算额度（幂等；批次已删除或已退还时静默跳过）。 */
  async function settleRoundIfDone(userId: string, batchId: string, round: number) {
    if ((await db.screenshot.count({ where: { batchId, round, status: { in: [...PENDING] } } })) > 0) return;
    if (!(await db.importBatch.findUnique({ where: { id: batchId }, select: { id: true } }))) return;
    const used = await db.screenshot.count({ where: { batchId, round, status: "DONE" } });
    try {
      await quota.settle(userId, "SCREENSHOT", roundKey(batchId, round), { used });
    } catch (e) {
      if (!(e instanceof QuotaError)) throw e;
    }
  }

  // ───────── worker：处理单张截图 ─────────

  type Outcome = { ok: true; messages: ParsedMessage[] } | { ok: false; code: string };

  /**
   * 在删除围栏内写回单张截图的结果：先锁对象、再以排他锁锁批次，并校验代际；
   * 批次或对象已被删除时抛出 NotFoundError（调用方丢弃结果）。
   */
  async function finishScreenshot(job: RecognitionJob, outcome: Outcome, from: "QUEUED" | "RUNNING") {
    const shot = await db.screenshot.findUnique({ where: { id: job.screenshotId } });
    if (!shot) return;
    try {
      await db.$transaction(async (tx) => {
        const batch = await lockPersonThenBatch(tx, shot.userId, shot.batchId);
        if (batch.generation !== job.generation) throw new NotFoundError("导入批次");
        const upd = await tx.screenshot.updateMany({
          where: { id: shot.id, status: from, round: job.round },
          data: outcome.ok
            ? { status: "DONE", result: outcome.messages as unknown as Prisma.InputJsonValue, finishedAt: now(), errorCode: null }
            : { status: "FAILED", errorCode: outcome.code, finishedAt: now() },
        });
        if (upd.count === 0) return; // 已被其他路径处理（重复投递、超时判失败）
        if ((await tx.screenshot.count({ where: { batchId: batch.id, status: { in: [...PENDING] } } })) === 0) await stageIfReady(tx, batch);
      });
    } catch (e) {
      if (e instanceof NotFoundError) return; // 批次或对象已删除：丢弃结果（额度已在删除时退还）
      throw e;
    }
    await settleRoundIfDone(shot.userId, shot.batchId, job.round);
  }

  /** worker 入口。重复投递、过期轮次、已删除的批次都安静退出。 */
  async function processScreenshot(job: RecognitionJob): Promise<void> {
    const claimed = await db.screenshot.updateMany({
      where: { id: job.screenshotId, status: "QUEUED", round: job.round },
      data: { status: "RUNNING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;
    const shot = await db.screenshot.findUniqueOrThrow({ where: { id: job.screenshotId } });

    let outcome: Outcome;
    try {
      const bytes = await storage.get(shot.storageKey);
      if (!bytes) throw new Error("原图不存在");
      outcome = { ok: true, messages: (await vision.recognize({ bytes, contentType: shot.contentType })).messages };
    } catch {
      // 不记录异常内容（可能含聊天文字），只记录失败类别
      outcome = { ok: false, code: "RECOGNITION_FAILED" };
    }
    await finishScreenshot(job, outcome, "RUNNING");
  }

  // ───────── 失败项处理 ─────────

  async function skipFailed(userId: string, batchId: string) {
    await ownedBatch(db, userId, batchId);
    await db.$transaction(async (tx) => {
      const batch = await lockPersonThenBatch(tx, userId, batchId);
      if (batch.status !== "RECOGNIZING") throw new ValidationError("当前不能跳过失败的截图");
      if ((await tx.screenshot.count({ where: { batchId, status: { in: [...PENDING] } } })) > 0) throw new ValidationError("还有截图正在识别");
      if ((await tx.screenshot.count({ where: { batchId, status: "FAILED" } })) === 0) throw new ValidationError("没有识别失败的截图");
      if ((await tx.screenshot.count({ where: { batchId, status: "DONE" } })) === 0) {
        throw new ValidationError("所有截图都识别失败，没有可用的结果。请重试，或放弃这批资料");
      }
      await tx.screenshot.updateMany({ where: { batchId, status: "FAILED" }, data: { status: "SKIPPED" } });
      await stageIfReady(tx, batch);
    });
  }

  /** 超过 15 分钟没有结果的排队/运行中任务（例如 worker 崩溃）判为失败，并退还对应额度。 */
  async function sweepStuck(): Promise<number> {
    const cutoff = new Date(now().getTime() - STUCK_AFTER_MS);
    const stuck = await db.screenshot.findMany({ where: { status: { in: [...PENDING] }, queuedAt: { lt: cutoff } } });
    let failed = 0;
    for (const s of stuck) {
      try {
        await db.$transaction(async (tx) => {
          const batch = await lockPersonThenBatch(tx, s.userId, s.batchId);
          const upd = await tx.screenshot.updateMany({
            where: { id: s.id, status: { in: [...PENDING] }, round: s.round },
            data: { status: "FAILED", errorCode: "TIMEOUT", finishedAt: now() },
          });
          if (upd.count === 0) return;
          failed++;
          if ((await tx.screenshot.count({ where: { batchId: batch.id, status: { in: [...PENDING] } } })) === 0) await stageIfReady(tx, batch);
        });
        if (s.round !== null) await settleRoundIfDone(s.userId, s.batchId, s.round);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    return failed;
  }

  // ───────── 查看原图（短时签名链接） ─────────

  /** 为本人未被撤销的原图签发短时链接；确认保存后的原图不再可访问。 */
  async function signedUrl(userId: string, screenshotId: string): Promise<string> {
    const s = await db.screenshot.findFirst({ where: { id: screenshotId, userId, revokedAt: null, purgedAt: null } });
    if (!s) throw new NotFoundError("截图");
    return storage.signToken(s.storageKey, SIGNED_URL_TTL_SECONDS);
  }

  /** 凭令牌读取原图：令牌有效、属于该用户且原图仍可访问。 */
  async function open(userId: string, token: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const key = storage.verifyToken(token);
    if (!key) throw new NotFoundError("截图");
    const s = await db.screenshot.findFirst({ where: { storageKey: key, userId, revokedAt: null, purgedAt: null } });
    if (!s) throw new NotFoundError("截图");
    const bytes = await storage.get(key);
    if (!bytes) throw new NotFoundError("截图");
    return { bytes, contentType: s.contentType };
  }

  return { addScreenshot, removeScreenshot, list, getProgress, start, retryFailed, skipFailed, processScreenshot, sweepStuck, signedUrl, open };
}

export type Recognition = ReturnType<typeof createRecognition>;
