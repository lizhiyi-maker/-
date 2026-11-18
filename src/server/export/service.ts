import type { Db } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import type { AnalysisOutput } from "@/domain/analysis/output";
import { formatChatText, type ChatTextBatch } from "@/domain/export";
import { computeFitScore, type Importance } from "@/domain/scoring/score";

export const EXPORT_FORMAT = "relationship-export";
export const EXPORT_VERSION = 1;

/**
 * 数据导出：用户自助导出自己的结构化资料与聊天文本（docs/business/privacy-retention.md §4）。
 * 只含本人、已保存的数据；**不含**手机号（明文、哈希、密文）、验证码、会话令牌、原图及存储路径、未保存的暂存消息、
 * 其他用户的任何数据。每个方法以 userId 限定范围，导出行为写审计（只记录数量，不含内容）。
 */
export function createExport(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  /** 一个对象已保存的聊天，按批次保存时间与批次内顺序排列，内容取当前修订。 */
  async function loadChat(userId: string, personId: string) {
    const batches = await db.importBatch.findMany({
      where: { userId, personId, status: "CONFIRMED" },
      orderBy: [{ confirmedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: {
        messages: {
          where: { state: "CONFIRMED" },
          orderBy: { seq: "asc" },
          include: { revisions: { orderBy: { revision: "asc" } } },
        },
      },
    });
    return batches;
  }

  const currentContent = (m: { currentRevision: number; revisions: { revision: number; content: string }[] }) =>
    m.revisions.find((r) => r.revision === m.currentRevision)?.content ?? m.revisions.at(-1)?.content ?? "";

  const toTextBatches = (batches: Awaited<ReturnType<typeof loadChat>>): ChatTextBatch[] =>
    batches.map((b) => ({
      platform: b.platform,
      dataKind: b.dataKind,
      confirmedAt: b.confirmedAt,
      messages: b.messages.map((m) => ({ speaker: m.speaker, type: m.type, content: currentContent(m), occurredAt: m.occurredAt, timePrecision: m.timePrecision })),
    }));

  async function build(userId: string) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    if (!user) throw new NotFoundError("用户");
    const [preference, quotaEntries, consents, feedback, people] = await Promise.all([
      db.preference.findUnique({ where: { userId } }),
      db.quotaEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { kind: true, type: true, delta: true, amount: true, periodKey: true, reason: true, createdAt: true } }),
      db.consentRecord.findMany({ where: { userId }, orderBy: { acceptedAt: "asc" }, select: { version: true, providerId: true, acceptedAt: true } }),
      db.feedback.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { category: true, message: true, snippet: true, status: true, createdAt: true } }),
      db.person.findMany({
        where: { userId, status: "ACTIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          accounts: { orderBy: { confirmedAt: "asc" }, select: { platform: true, handle: true, confirmedAt: true } },
          feelings: { orderBy: { createdAt: "asc" }, select: { value: true, createdAt: true } },
          events: { orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }], include: { revisions: { orderBy: { revision: "asc" } } } },
          analyses: { where: { status: "SUCCEEDED" }, orderBy: [{ snapshotAt: "asc" }, { id: "asc" }] },
        },
      }),
    ]);

    const exported = [];
    for (const p of people) {
      const batches = await loadChat(userId, p.id);
      exported.push({
        id: p.id,
        nickname: p.nickname,
        gender: p.gender,
        channel: p.channel,
        metAtApprox: p.metAtApprox,
        stage: p.stage,
        hasMet: p.hasMet,
        seesAsAmbiguous: p.seesAsAmbiguous,
        /** 你自己写的个人感受与期待 */
        feelingsNote: p.feelingsNote,
        expectationsNote: p.expectationsNote,
        createdAt: p.createdAt,
        platformAccounts: p.accounts,
        /** “我的好感”的修改历史 */
        feelingHistory: p.feelings,
        batches: batches.map((b) => ({
          id: b.id,
          platform: b.platform,
          sourceKind: b.sourceKind,
          dataKind: b.dataKind,
          confirmedAt: b.confirmedAt,
          messages: b.messages.map((m) => ({
            id: m.id,
            seq: m.seq,
            speaker: m.speaker,
            type: m.type,
            occurredAt: m.occurredAt,
            timePrecision: m.timePrecision,
            recognition: m.recognition,
            currentRevision: m.currentRevision,
            revisions: m.revisions.map((r) => ({ revision: r.revision, content: r.content, createdAt: r.createdAt })),
          })),
        })),
        offlineEvents: p.events.map((e) => ({
          id: e.id,
          kind: e.kind,
          occurredOn: e.occurredOn.toISOString().slice(0, 10),
          currentRevision: e.currentRevision,
          /** 事实（可被报告引用）按修订保存 */
          factRevisions: e.revisions.map((r) => ({ revision: r.revision, kind: r.kind, occurredOn: r.occurredOn.toISOString().slice(0, 10), facts: r.facts, createdAt: r.createdAt })),
          /** 你对这个事件的个人感受（不发送给 AI 服务商） */
          personalNote: e.personalNote,
          createdAt: e.createdAt,
        })),
        analyses: p.analyses.map((a) => {
          const output = a.output as unknown as AnalysisOutput;
          const importance = ((a.preferenceValues as { importance?: Importance } | null)?.importance ?? {}) as Importance;
          return {
            id: a.id,
            snapshotAt: a.snapshotAt,
            messageCount: a.messageCount,
            eventCount: a.eventCount,
            rulesVersion: a.rulesVersion,
            promptVersion: a.promptVersion,
            modelId: a.modelId,
            preferenceVersion: a.preferenceVersion,
            importance,
            fitScore: computeFitScore(output.dimensions, importance),
            explicitRefusal: a.explicitRefusal,
            report: output,
          };
        }),
        chatText: formatChatText(p.nickname, toTextBatches(batches)),
      });
    }

    await db.auditLog.create({ data: { actorId: userId, action: "export.download", targetType: "User", targetId: userId, meta: { people: exported.length }, createdAt: now() } });

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: now(),
      notes: [
        "这是你在关系工作台里保存的全部结构化资料，只包含你自己的数据。",
        "不包含：手机号、验证码、登录凭证、已清理的聊天截图原图、尚未确认保存的导入内容。",
        "报告里的分数与分析结果是实验规则下的产物，不是对人的评价，也不预测结果。",
      ],
      account: { createdAt: user.createdAt },
      preferences: preference
        ? { version: preference.version, expectation: preference.expectation, contactFrequency: preference.contactFrequency, pace: preference.pace, importance: preference.importance, updatedAt: preference.updatedAt }
        : null,
      consents,
      quotaLedger: quotaEntries,
      /** 你提交过的反馈（含你主动附上的片段） */
      feedback,
      people: exported,
    };
  }

  /** 单个对象的可读聊天文本；不属于该用户的对象与不存在的表现一致（NotFoundError）。 */
  async function chatText(userId: string, personId: string): Promise<{ nickname: string; text: string }> {
    const p = await db.person.findFirst({ where: { id: personId, userId, status: "ACTIVE" }, select: { nickname: true } });
    if (!p) throw new NotFoundError("对象");
    return { nickname: p.nickname, text: formatChatText(p.nickname, toTextBatches(await loadChat(userId, personId))) };
  }

  return { build, chatText };
}

export type Exporter = ReturnType<typeof createExport>;
