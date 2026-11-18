import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import { lockLivePerson, type Tx } from "@/server/people/service";
import type { Preferences } from "@/server/preferences/service";
import { QuotaError, type Quota } from "@/server/quota/ledger";
import type { Consent } from "@/server/consent/service";
import type { Usage } from "@/server/usage/service";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { computeFreshness, type Freshness } from "@/domain/analysis/freshness";
import { evidenceKey, isEventRef, type AnalysisOutput, type EvidenceRef } from "@/domain/analysis/output";
import type { EventKind } from "@/domain/events";
import { computeFitScore, type FitScore, type Importance } from "@/domain/scoring/score";
import { RULES_VERSION } from "@/domain/analysis/rules";
import type { DataKind } from "@/domain/analysis/evidence";
import type { MessageType, Speaker, TimePrecision } from "@/domain/chat/types";
import { runAnalysisPipeline, type DimensionVerification, type SnapshotEvent, type SnapshotMessage } from "./pipeline";

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
  /** 记录每次模型调用的用量与估算成本（可选；不含内容） */
  usage?: Pick<Usage, "record">;
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

/** 分析快照里一个线下事件的版本引用。事实内容按 (事件, 修订) 回查 OfflineEventRevision；个人感受不在快照里。 */
interface SnapshotEventRef {
  id: string;
  revision: number;
  kind: EventKind;
  /** YYYY-MM-DD */
  occurredOn: string;
}

export interface ReportView {
  id: string;
  snapshotAt: Date;
  finishedAt: Date | null;
  messageCount: number;
  eventCount: number;
  batchSummary: Record<DataKind, number>;
  rulesVersion: string;
  promptVersion: string;
  modelId: string;
  preferenceVersion: number;
  /** 这份报告分析时使用的维度重要程度（取自快照里的偏好） */
  importance: Importance;
  /** 适配分：按规则版本与上面的重要程度，由已保存的分析结果纯函数算出；未五维全已知时没有分数 */
  fit: FitScore;
  output: AnalysisOutput;
  verification: Record<string, DimensionVerification>;
  warnings: string[];
  explicitRefusal: boolean;
}

export interface EvidenceEntry {
  /** 聊天消息，或用户补充的线下事件（此时 content 是事件的事实，不含个人感受） */
  source: "message" | "event";
  eventKind: EventKind | null;
  unavailable: boolean;
  content: string;
  speaker: Speaker;
  type: MessageType;
  occurredAt: Date | null;
  timePrecision: TimePrecision;
  /** 引用的修订号 */
  revision: number;
  /** 消息/事件当前的修订号；与 revision 不同说明引用之后被用户修改过；已删除时为 null */
  currentRevision: number | null;
  before: { speaker: Speaker; content: string } | null;
  after: { speaker: Speaker; content: string } | null;
}

/** 快照里记录的维度重要程度；缺失时由评分函数补默认值。 */
const savedImportance = (preferenceValues: unknown): Importance => ((preferenceValues as { importance?: Importance } | null)?.importance ?? {}) as Importance;

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

  async function takeEventSnapshot(tx: Tx, userId: string, personId: string): Promise<SnapshotEventRef[]> {
    const rows = await tx.offlineEvent.findMany({ where: { userId, personId }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    return rows.map((e) => ({ id: e.id, revision: e.currentRevision, kind: e.kind, occurredOn: e.occurredOn.toISOString().slice(0, 10) }));
  }

  /** 按 (事件, 修订) 回查事件当时的事实（类型、日期、经过）。 */
  async function eventRevisions(client: Db | Tx, refs: { id: string; revision: number }[]) {
    const out = new Map<string, { kind: EventKind; occurredOn: Date; facts: string }>();
    for (const part of chunks(refs)) {
      const rows = await client.offlineEventRevision.findMany({
        where: { OR: part.map((r) => ({ eventId: r.id, revision: r.revision })) },
        select: { eventId: true, revision: true, kind: true, occurredOn: true, facts: true },
      });
      for (const r of rows) out.set(`${r.eventId}:${r.revision}`, { kind: r.kind, occurredOn: r.occurredOn, facts: r.facts });
    }
    return out;
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

  /**
   * 快照里的消息与事件是否都还在、且仍是被引用的修订（资料被删除或纠正后为 true）。
   * 事件只看事实修订：个人感受的改动不产生修订，因此不会让报告过期。
   */
  async function refsStale(client: Db | Tx, refs: { id: string; revision: number }[], eventRefs: { id: string; revision: number }[] = []): Promise<boolean> {
    for (const part of chunks(eventRefs, 1000)) {
      const rows = await client.offlineEvent.findMany({ where: { id: { in: part.map((r) => r.id) } }, select: { id: true, currentRevision: true } });
      const current = new Map(rows.map((r) => [r.id, r.currentRevision]));
      if (part.some((r) => current.get(r.id) !== r.revision)) return true;
    }
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
        const eventRefs = await takeEventSnapshot(tx, userId, personId);
        await tx.analysis.create({
          data: {
            id,
            userId,
            personId,
            generation: person.generation,
            snapshotAt: now(),
            messageCount: refs.length,
            snapshotRefs: refs as unknown as Prisma.InputJsonValue,
            eventRefs: eventRefs as unknown as Prisma.InputJsonValue,
            eventCount: eventRefs.length,
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
        if (result.status === "SUCCEEDED" && (await refsStale(tx, a.snapshotRefs as unknown as SnapshotRef[], a.eventRefs as unknown as SnapshotEventRef[]))) result = { status: "INVALIDATED" };
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
    const eventRefs = a.eventRefs as unknown as SnapshotEventRef[];
    const revisions = await eventRevisions(db, eventRefs);
    if (eventRefs.some((r) => !revisions.has(`${r.id}:${r.revision}`))) {
      await finish(a.id, { status: "INVALIDATED" }, "RUNNING"); // 提交之后事件已被删除
      return;
    }
    const events: SnapshotEvent[] = eventRefs.map((r) => {
      const rev = revisions.get(`${r.id}:${r.revision}`)!;
      return { id: r.id, revision: r.revision, kind: rev.kind, occurredOn: rev.occurredOn, content: rev.facts };
    });
    const prefs = a.preferenceValues as { expectation: string | null; contactFrequency: string | null; pace: string | null };

    const result = await runAnalysisPipeline({
      messages,
      events,
      model,
      preferences: { expectation: prefs.expectation, contactFrequency: prefs.contactFrequency, pace: prefs.pace },
      userContext: { feelingsNote: person.feelingsNote, currentFeeling: person.feelings[0]?.value ?? null },
    });
    // 失败与成功的调用都记用量（调用确实发生了）；写入失败不影响分析
    await deps.usage?.record(
      result.usage.map((u) => ({ userId: a.userId, kind: u.kind, taskId: a.id, modelId: model.id, simulated: model.simulated ?? false, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs, success: u.success })),
    );
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
    latest: { snapshotRefs: unknown; eventRefs: unknown; rulesVersion: string; preferenceVersion: number },
    preferenceVersion: number,
  ): Promise<Freshness> {
    const refs = latest.snapshotRefs as SnapshotRef[];
    const eventRefs = latest.eventRefs as SnapshotEventRef[];
    const included = new Set(refs.map((r) => r.batchId));
    const includedEvents = new Set(eventRefs.map((r) => r.id));
    const confirmed = await db.importBatch.findMany({ where: { userId, personId, status: "CONFIRMED" }, select: { id: true } });
    const events = await db.offlineEvent.findMany({ where: { userId, personId }, select: { id: true } });
    return computeFreshness(
      { rulesVersion: latest.rulesVersion, preferenceVersion: latest.preferenceVersion },
      {
        rulesVersion,
        preferenceVersion,
        hasNewData: confirmed.some((b) => !included.has(b.id)) || events.some((e) => !includedEvents.has(e.id)),
        hasStaleRefs: await refsStale(db, refs, eventRefs),
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
      eventCount: latest.eventCount,
      batchSummary,
      rulesVersion: latest.rulesVersion,
      promptVersion: latest.promptVersion,
      modelId: latest.modelId,
      preferenceVersion: latest.preferenceVersion,
      importance: savedImportance(latest.preferenceValues),
      fit: computeFitScore((latest.output as unknown as AnalysisOutput).dimensions, savedImportance(latest.preferenceValues)),
      output: latest.output as unknown as AnalysisOutput,
      verification: meta.verification ?? {},
      warnings: meta.warnings ?? [],
      explicitRefusal: latest.explicitRefusal,
    };
    return { running, latest: view, freshness: await freshnessOf(userId, personId, latest, prefs.version) };
  }

  /**
   * 展开证据：引用的消息/事件内容取自被引用的修订（即使之后被修改，仍是分析当时看到的内容）。
   * 消息另附前后各一条上下文；事件展开的是事实，不含用户的个人感受。
   */
  async function loadEvidence(userId: string, analysisId: string): Promise<Record<string, EvidenceEntry>> {
    const a = await db.analysis.findFirst({ where: { id: analysisId, userId, status: "SUCCEEDED" } });
    if (!a) throw new NotFoundError("分析报告");
    const out = a.output as unknown as AnalysisOutput;
    const cited = new Map<string, { id: string; revision: number }>();
    const citedEvents = new Map<string, { id: string; revision: number }>();
    const add = (r: EvidenceRef) => {
      if (isEventRef(r)) citedEvents.set(`${r.eventId}:${r.revision}`, { id: r.eventId, revision: r.revision });
      else cited.set(`${r.messageId}:${r.revision}`, { id: r.messageId, revision: r.revision });
    };
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
      result[evidenceKey({ messageId: c.id, revision: c.revision })] = {
        source: "message",
        eventKind: null,
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

    if (citedEvents.size > 0) {
      const revisions = await eventRevisions(db, [...citedEvents.values()]);
      const currentEvents = new Map<string, number>();
      for (const part of chunks([...citedEvents.values()], 1000)) {
        const rows = await db.offlineEvent.findMany({ where: { id: { in: part.map((c) => c.id) } }, select: { id: true, currentRevision: true } });
        rows.forEach((r) => currentEvents.set(r.id, r.currentRevision));
      }
      for (const [key, c] of citedEvents) {
        const rev = revisions.get(key);
        result[evidenceKey({ eventId: c.id, revision: c.revision })] = {
          source: "event",
          eventKind: rev?.kind ?? null,
          unavailable: rev === undefined,
          content: rev?.facts ?? "",
          speaker: "UNKNOWN",
          type: "OTHER",
          occurredAt: rev?.occurredOn ?? null,
          timePrecision: "DATE",
          revision: c.revision,
          currentRevision: currentEvents.get(c.id) ?? null,
          before: null,
          after: null,
        };
      }
    }
    return result;
  }

  /** 复盘：对象所有成功的分析快照（从旧到新），带资料范围、规则/偏好版本与当时的结论。 */
  async function listSnapshots(userId: string, personId: string) {
    await ownedPerson(db, userId, personId);
    const rows = await db.analysis.findMany({
      where: { userId, personId, status: "SUCCEEDED" },
      orderBy: [{ snapshotAt: "asc" }, { id: "asc" }],
      select: { id: true, snapshotAt: true, messageCount: true, eventCount: true, rulesVersion: true, preferenceVersion: true, preferenceValues: true, output: true },
    });
    return rows.map(({ output, preferenceValues, ...r }) => {
      const out = output as unknown as AnalysisOutput;
      return { ...r, summary: out?.conclusion.summary ?? "", fit: computeFitScore(out.dimensions, savedImportance(preferenceValues)) };
    });
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

  return { start, process, sweepStuck, getReport, loadEvidence, listSnapshots, listTodo };
}

export type AnalysisService = ReturnType<typeof createAnalysis>;
