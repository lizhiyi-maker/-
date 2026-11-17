import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import { lockLivePerson, type Tx } from "@/server/people/service";
import type { Preferences } from "@/server/preferences/service";
import { QuotaError, type Quota } from "@/server/quota/ledger";
import type { Consent } from "@/server/consent/service";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { computeFreshness, type Freshness } from "@/domain/analysis/freshness";
import type { AnalysisOutput } from "@/domain/analysis/output";
import { RULES_VERSION } from "@/domain/analysis/rules";
import type { DataKind } from "@/domain/analysis/evidence";
import type { MessageType, Speaker, TimePrecision } from "@/domain/chat/types";
import { runAnalysisPipeline, type DimensionVerification, type SnapshotMessage } from "./pipeline";

export interface AnalysisJob {
  analysisId: string;
  /** 提交时对象的代际 */
  generation: number;
}

export interface AnalysisDeps {
  quota: Quota;
  /** 首次向 AI 服务商发送内容前必须已同意 */
  consent: Pick<Consent, "assertAccepted">;
  preferences: Pick<Preferences, "get">;
  model: AnalysisModel;
  queue: { enqueue(job: AnalysisJob): Promise<void> };
  now?: () => Date;
  /** 当前规则版本；默认取评分配置里的版本 */
  rulesVersion?: string;
}

/** 分析快照里一条消息的版本引用。内容不重复存放：按 (消息, 修订) 回查 MessageRevision 重建。 */
interface SnapshotRef {
  id: string;
  revision: number;
  batchId: string;
  dataKind: DataKind;
  seq: number;
  speaker: Speaker;
  type: MessageType;
  occurredAt: string | null;
  timePrecision: TimePrecision;
}

export interface ReportView {
  id: string;
  snapshotAt: Date;
  finishedAt: Date | null;
  messageCount: number;
  batchSummary: Record<DataKind, number>;
  rulesVersion: string;
  promptVersion: string;
  modelId: string;
  preferenceVersion: number;
  output: AnalysisOutput;
  verification: Record<string, DimensionVerification>;
  warnings: string[];
  explicitRefusal: boolean;
}

export interface EvidenceEntry {
  unavailable: boolean;
  content: string;
  speaker: Speaker;
  type: MessageType;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  /** 引用的修订号 */
  revision: number;
  /** 消息当前的修订号；与 revision 不同说明引用之后被用户修改过；消息已删除时为 null */
  currentRevision: number | null;
  before: { speaker: Speaker; content: string } | null;
  after: { speaker: Speaker; content: string } | null;
}

const STUCK_AFTER_MS = 15 * 60_000;
const CHUNK = 500;
const analysisKey = (id: string) => `analysis:${id}`;

const chunks = <T>(items: T[], size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * 关系分析服务。流程：用户点“开始分析”（需已同意 AI 服务说明，且有已保存的资料）→ 取资料快照并预留 1 次分析额度 → 入队 →
 * worker 执行流水线 → 在删除围栏内写回；成功结算额度，失败/作废退还。新增资料不会自动分析。
 * 所有方法以 userId 限定范围。规则见 docs/business/analysis-spec.md。
 */
export function createAnalysis(db: Db, deps: AnalysisDeps) {
  const now = deps.now ?? (() => new Date());
  const { quota, model, queue } = deps;
  const rulesVersion = deps.rulesVersion ?? RULES_VERSION;

  async function ownedPerson(client: Db | Tx, userId: string, personId: string) {
    const p = await client.person.findFirst({ where: { id: personId, userId, status: "ACTIVE" } });
    if (!p) throw new NotFoundError("对象");
    return p;
  }

  // ───────── 快照 ─────────

  async function takeSnapshot(tx: Tx, userId: string, personId: string): Promise<SnapshotRef[]> {
    const rows = await tx.message.findMany({
      where: { userId, personId, state: "CONFIRMED" },
      include: { batch: { select: { dataKind: true } } },
      orderBy: [{ batch: { confirmedAt: "asc" } }, { seq: "asc" }],
    });
    return rows.map((m) => ({
      id: m.id,
      revision: m.currentRevision,
      batchId: m.batchId,
      dataKind: m.batch.dataKind,
      seq: m.seq,
      speaker: m.speaker,
      type: m.type,
      occurredAt: m.occurredAt?.toISOString() ?? null,
      timePrecision: m.timePrecision,
    }));
  }

  async function revisionContents(client: Db | Tx, refs: { id: string; revision: number }[]) {
    const out = new Map<string, string>();
    for (const part of chunks(refs)) {
      const rows = await client.messageRevision.findMany({
        where: { OR: part.map((r) => ({ messageId: r.id, revision: r.revision })) },
        select: { messageId: true, revision: true, content: true },
      });
      for (const r of rows) out.set(`${r.messageId}:${r.revision}`, r.content);
    }
    return out;
  }

  /** 快照里的消息是否都还在、且仍是被引用的修订（资料被删除或纠正后为 true）。 */
  async function refsStale(client: Db | Tx, refs: { id: string; revision: number }[]): Promise<boolean> {
    let found = 0;
    for (const part of chunks(refs, 1000)) {
      const rows = await client.message.findMany({ where: { id: { in: part.map((r) => r.id) } }, select: { id: true, currentRevision: true, state: true } });
      const current = new Map(rows.map((r) => [r.id, r]));
      for (const r of part) {
        const c = current.get(r.id);
        if (!c || c.state !== "CONFIRMED" || c.currentRevision !== r.revision) return true;
        found++;
      }
    }
    return found !== refs.length;
  }

  // ───────── 提交 ─────────

  async function start(userId: string, personId: string): Promise<{ analysisId: string }> {
    await deps.consent.assertAccepted(userId); // 内容会发送给 AI 服务商
    await ownedPerson(db, userId, personId);
    if ((await db.message.count({ where: { userId, personId, state: "CONFIRMED" } })) === 0) {
      throw new ValidationError("请先导入并保存聊天资料，再开始分析");
    }
    const prefs = await deps.preferences.get(userId);
    const id = randomUUID();
    const key = analysisKey(id);
    await quota.reserve(userId, "ANALYSIS", 1, key); // 额度不足时抛出 InsufficientQuotaError，不留记录

    let generation: number;
    try {
      generation = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`analysis:start:${personId}`}, 0))`;
        const person = await ownedPerson(tx, userId, personId);
        await lockLivePerson(tx, userId, personId);
        if ((await tx.analysis.count({ where: { personId, status: { in: ["QUEUED", "RUNNING"] } } })) > 0) throw new ValidationError("已经有一次分析正在进行");
        const refs = await takeSnapshot(tx, userId, personId);
        if (refs.length === 0) throw new ValidationError("请先导入并保存聊天资料，再开始分析");
        await tx.analysis.create({
          data: {
            id,
            userId,
            personId,
            generation: person.generation,
            snapshotAt: now(),
            messageCount: refs.length,
            snapshotRefs: refs as unknown as Prisma.InputJsonValue,
            preferenceVersion: prefs.version,
            preferenceValues: { expectation: prefs.expectation, contactFrequency: prefs.contactFrequency, pace: prefs.pace, importance: prefs.importance },
            rulesVersion,
            promptVersion: model.promptVersion,
            modelId: model.id,
            queuedAt: now(),
          },
        });
        return person.generation;
      });
    } catch (e) {
      await quota.release(userId, "ANALYSIS", key).catch(() => {});
      throw e;
    }

    try {
      await queue.enqueue({ analysisId: id, generation });
    } catch {
      await finish(id, { status: "FAILED", errorCode: "QUEUE_FAILED" }, "QUEUED");
    }
    return { analysisId: id };
  }

  // ───────── 写回（删除围栏内）与额度 ─────────

  type Outcome =
    | { status: "SUCCEEDED"; output: AnalysisOutput; meta: Prisma.InputJsonValue; explicitRefusal: boolean }
    | { status: "FAILED"; errorCode: string }
    | { status: "INVALIDATED" };

  /**
   * 在删除围栏内写回结果：先锁对象并校验代际，再以排他锁锁定分析记录且要求仍处于进行中。
   * 成功结果写回前再次确认快照里的资料没有被删除或纠正，否则作废。对象已删除时安静退出（额度已在删除时退还）。
   */
  async function finish(analysisId: string, outcome: Outcome, from: "QUEUED" | "RUNNING"): Promise<void> {
    const a = await db.analysis.findUnique({ where: { id: analysisId } });
    if (!a) return;
    let final: Outcome["status"] | null = null;
    try {
      final = await db.$transaction(async (tx) => {
        await lockLivePerson(tx, a.userId, a.personId, a.generation);
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Analysis" WHERE "id" = ${analysisId} AND "status"::text = ${from} FOR UPDATE`;
        if (locked.length === 0) return null; // 已被其他路径处理
        let result = outcome;
        if (result.status === "SUCCEEDED" && (await refsStale(tx, a.snapshotRefs as unknown as SnapshotRef[]))) result = { status: "INVALIDATED" };
        await tx.analysis.update({
          where: { id: analysisId },
          data:
            result.status === "SUCCEEDED"
              ? { status: "SUCCEEDED", output: result.output as unknown as Prisma.InputJsonValue, meta: result.meta, explicitRefusal: result.explicitRefusal, finishedAt: now() }
              : result.status === "FAILED"
                ? { status: "FAILED", errorCode: result.errorCode, finishedAt: now() }
                : { status: "INVALIDATED", errorCode: "INPUT_CHANGED", finishedAt: now() },
        });
        return result.status;
      });
    } catch (e) {
      if (e instanceof NotFoundError) return;
      throw e;
    }
    if (final === null) return;
    try {
      if (final === "SUCCEEDED") await quota.settle(a.userId, "ANALYSIS", analysisKey(analysisId));
      else await quota.release(a.userId, "ANALYSIS", analysisKey(analysisId), final === "INVALIDATED" ? "分析期间资料变化，退还额度" : "系统失败退还");
    } catch (e) {
      if (!(e instanceof QuotaError)) throw e;
    }
  }

  // ───────── worker ─────────

  /** worker 入口。认领后执行流水线；重复投递、已删除的对象都安静退出。 */
  async function process(job: AnalysisJob): Promise<void> {
    const claimed = await db.analysis.updateMany({ where: { id: job.analysisId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: now() } });
    if (claimed.count === 0) return;
    const a = await db.analysis.findUniqueOrThrow({ where: { id: job.analysisId } });
    const person = await db.person.findUnique({ where: { id: a.personId }, select: { feelingsNote: true, feelings: { orderBy: { createdAt: "desc" }, take: 1, select: { value: true } } } });
    if (!person) return;

    const refs = a.snapshotRefs as unknown as SnapshotRef[];
    const contents = await revisionContents(db, refs);
    if (refs.some((r) => !contents.has(`${r.id}:${r.revision}`))) {
      await finish(a.id, { status: "INVALIDATED" }, "RUNNING"); // 提交之后资料已被删除
      return;
    }
    const messages: SnapshotMessage[] = refs.map((r) => ({
      id: r.id,
      revision: r.revision,
      batchId: r.batchId,
      seq: r.seq,
      speaker: r.speaker,
      type: r.type,
      content: contents.get(`${r.id}:${r.revision}`)!,
      occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
      timePrecision: r.timePrecision,
      dataKind: r.dataKind,
    }));
    const prefs = a.preferenceValues as { expectation: string | null; contactFrequency: string | null; pace: string | null };

    const result = await runAnalysisPipeline({
      messages,
      model,
      preferences: { expectation: prefs.expectation, contactFrequency: prefs.contactFrequency, pace: prefs.pace },
      userContext: { feelingsNote: person.feelingsNote, currentFeeling: person.feelings[0]?.value ?? null },
    });
    if (!result.ok) {
      await finish(a.id, { status: "FAILED", errorCode: result.code }, "RUNNING");
      return;
    }
    await finish(
      a.id,
      { status: "SUCCEEDED", output: result.output, meta: result.meta as unknown as Prisma.InputJsonValue, explicitRefusal: result.output.explicitRefusal.detected },
      "RUNNING",
    );
  }

  /** 排队/运行超过 15 分钟没有结果（例如 worker 崩溃）的分析判为失败并退还额度。 */
  async function sweepStuck(): Promise<number> {
    const stuck = await db.analysis.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] }, queuedAt: { lt: new Date(now().getTime() - STUCK_AFTER_MS) } }, select: { id: true, status: true } });
    let n = 0;
    for (const s of stuck) {
      const before = await db.analysis.findUnique({ where: { id: s.id }, select: { status: true } });
      await finish(s.id, { status: "FAILED", errorCode: "TIMEOUT" }, s.status as "QUEUED" | "RUNNING");
      const after = await db.analysis.findUnique({ where: { id: s.id }, select: { status: true } });
      if (before && after?.status === "FAILED") n++;
    }
    return n;
  }

  // ───────── 报告与新鲜度 ─────────

  async function freshnessOf(
    userId: string,
    personId: string,
    latest: { snapshotRefs: unknown; rulesVersion: string; preferenceVersion: number },
    preferenceVersion: number,
  ): Promise<Freshness> {
    const refs = latest.snapshotRefs as SnapshotRef[];
    const included = new Set(refs.map((r) => r.batchId));
    const confirmed = await db.importBatch.findMany({ where: { userId, personId, status: "CONFIRMED" }, select: { id: true } });
    return computeFreshness(
      { rulesVersion: latest.rulesVersion, preferenceVersion: latest.preferenceVersion },
      {
        rulesVersion,
        preferenceVersion,
        hasNewData: confirmed.some((b) => !included.has(b.id)),
        hasStaleRefs: await refsStale(db, refs),
      },
    );
  }

  async function getReport(userId: string, personId: string) {
    await ownedPerson(db, userId, personId);
    const [running, latest, prefs] = await Promise.all([
      db.analysis.findFirst({ where: { userId, personId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { queuedAt: "desc" }, select: { id: true, status: true, queuedAt: true } }),
      db.analysis.findFirst({ where: { userId, personId, status: "SUCCEEDED" }, orderBy: [{ finishedAt: "desc" }, { queuedAt: "desc" }] }),
      deps.preferences.get(userId),
    ]);
    if (!latest) return { running, latest: null as ReportView | null, freshness: null as Freshness | null };

    const refs = latest.snapshotRefs as unknown as SnapshotRef[];
    const batches = new Map(refs.map((r) => [r.batchId, r.dataKind]));
    const batchSummary: Record<DataKind, number> = { CONTINUOUS: 0, CURATED: 0, UNCERTAIN: 0 };
    for (const kind of batches.values()) batchSummary[kind]++;
    const meta = (latest.meta ?? {}) as { verification?: Record<string, DimensionVerification>; warnings?: string[] };
    const view: ReportView = {
      id: latest.id,
      snapshotAt: latest.snapshotAt,
      finishedAt: latest.finishedAt,
      messageCount: latest.messageCount,
      batchSummary,
      rulesVersion: latest.rulesVersion,
      promptVersion: latest.promptVersion,
      modelId: latest.modelId,
      preferenceVersion: latest.preferenceVersion,
      output: latest.output as unknown as AnalysisOutput,
      verification: meta.verification ?? {},
      warnings: meta.warnings ?? [],
      explicitRefusal: latest.explicitRefusal,
    };
    return { running, latest: view, freshness: await freshnessOf(userId, personId, latest, prefs.version) };
  }

  /**
   * 展开证据：引用的消息内容取自被引用的修订（即使之后被修改，仍是分析当时看到的内容），
   * 并附上前后各一条作为上下文。
   */
  async function loadEvidence(userId: string, analysisId: string): Promise<Record<string, EvidenceEntry>> {
    const a = await db.analysis.findFirst({ where: { id: analysisId, userId, status: "SUCCEEDED" } });
    if (!a) throw new NotFoundError("分析报告");
    const out = a.output as unknown as AnalysisOutput;
    const cited = new Map<string, { id: string; revision: number }>();
    const add = (r: { messageId: string; revision: number }) => cited.set(`${r.messageId}:${r.revision}`, { id: r.messageId, revision: r.revision });
    for (const d of Object.values(out.dimensions)) for (const f of [...d.observedFacts, ...d.supporting, ...d.counter]) f.refs.forEach(add);
    out.suggestions.forEach((s) => s.refs.forEach(add));
    out.explicitRefusal.refs.forEach(add);

    const snapshot = new Map((a.snapshotRefs as unknown as SnapshotRef[]).map((r) => [r.id, r]));
    const contents = await revisionContents(db, [...cited.values()]);
    const current = new Map<string, { currentRevision: number; batchId: string; seq: number }>();
    for (const part of chunks([...cited.values()], 1000)) {
      const rows = await db.message.findMany({ where: { id: { in: part.map((c) => c.id) } }, select: { id: true, currentRevision: true, batchId: true, seq: true } });
      rows.forEach((r) => current.set(r.id, r));
    }

    // 上下文：同一批次里相邻的前后各一条（取其当前内容）
    const neighbours = new Map<string, { speaker: Speaker; content: string }>();
    const want = [...current.values()].flatMap((c) => [
      { batchId: c.batchId, seq: c.seq - 1 },
      { batchId: c.batchId, seq: c.seq + 1 },
    ]);
    for (const part of chunks(want, 200)) {
      const rows = await db.message.findMany({
        where: { OR: part.map((w) => ({ batchId: w.batchId, seq: w.seq })), state: "CONFIRMED" },
        select: { batchId: true, seq: true, speaker: true, revisions: { orderBy: { revision: "desc" }, take: 1, select: { content: true } } },
      });
      for (const r of rows) neighbours.set(`${r.batchId}:${r.seq}`, { speaker: r.speaker, content: r.revisions[0]?.content ?? "" });
    }

    const result: Record<string, EvidenceEntry> = {};
    for (const [key, c] of cited) {
      const meta = snapshot.get(c.id);
      const cur = current.get(c.id);
      const content = contents.get(key);
      result[key] = {
        unavailable: content === undefined || !meta,
        content: content ?? "",
        speaker: meta?.speaker ?? "UNKNOWN",
        type: meta?.type ?? "TEXT",
        occurredAt: meta?.occurredAt ? new Date(meta.occurredAt) : null,
        timePrecision: meta?.timePrecision ?? "UNKNOWN",
        revision: c.revision,
        currentRevision: cur?.currentRevision ?? null,
        before: cur ? (neighbours.get(`${cur.batchId}:${cur.seq - 1}`) ?? null) : null,
        after: cur ? (neighbours.get(`${cur.batchId}:${cur.seq + 1}`) ?? null) : null,
      };
    }
    return result;
  }

  /** 首页待办：有已保存资料、没有进行中的分析，但从未分析或报告已不是“最新”的对象。 */
  async function listTodo(userId: string): Promise<{ personId: string; nickname: string; reason: "NEVER" | Exclude<Freshness, "FRESH"> }[]> {
    const people = await db.person.findMany({ where: { userId, status: "ACTIVE" }, select: { id: true, nickname: true }, orderBy: { updatedAt: "desc" } });
    const prefs = await deps.preferences.get(userId);
    const todo: { personId: string; nickname: string; reason: "NEVER" | Exclude<Freshness, "FRESH"> }[] = [];
    for (const p of people) {
      if ((await db.message.count({ where: { userId, personId: p.id, state: "CONFIRMED" } })) === 0) continue;
      if ((await db.analysis.count({ where: { personId: p.id, status: { in: ["QUEUED", "RUNNING"] } } })) > 0) continue;
      const latest = await db.analysis.findFirst({ where: { userId, personId: p.id, status: "SUCCEEDED" }, orderBy: [{ finishedAt: "desc" }, { queuedAt: "desc" }] });
      if (!latest) {
        todo.push({ personId: p.id, nickname: p.nickname, reason: "NEVER" });
        continue;
      }
      const f = await freshnessOf(userId, p.id, latest, prefs.version);
      if (f !== "FRESH") todo.push({ personId: p.id, nickname: p.nickname, reason: f });
    }
    return todo;
  }

  return { start, process, sweepStuck, getReport, loadEvidence, listTodo };
}

export type AnalysisService = ReturnType<typeof createAnalysis>;
