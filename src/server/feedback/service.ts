import type { Db } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { FEEDBACK_LIMITS, feedbackInputSchema, type FeedbackInput } from "@/domain/feedback";

/**
 * 用户反馈：提交与查看自己提交过的反馈。管理员列表与“标记已处理”在管理服务里（带审计、手机号脱敏）。
 * 反馈只含用户自己写下的文字与主动粘贴的片段，系统不自动附带任何聊天或对象信息；随账户删除一并删除。
 */
export function createFeedback(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function submit(userId: string, input: FeedbackInput): Promise<{ id: string }> {
    const r = feedbackInputSchema.safeParse(input);
    if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "反馈无效");
    // 简单防刷：每人每 24 小时最多提交若干条
    const recent = await db.feedback.count({ where: { userId, createdAt: { gte: new Date(now().getTime() - 86_400_000) } } });
    if (recent >= FEEDBACK_LIMITS.perDay) throw new ValidationError("今天提交的反馈已经很多了，请明天再试");
    const row = await db.feedback.create({ data: { userId, category: r.data.category, message: r.data.message, snippet: r.data.snippet ?? null, createdAt: now() } });
    return { id: row.id };
  }

  /** 我提交过的反馈，从新到旧。 */
  async function mine(userId: string) {
    return db.feedback.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, category: true, message: true, snippet: true, status: true, createdAt: true } });
  }

  return { submit, mine };
}

export type Feedback = ReturnType<typeof createFeedback>;
