import { z } from "zod";

export const FEEDBACK_CATEGORIES = ["BUG", "SUGGESTION", "INACCURATE", "OTHER"] as const;
export type FeedbackCategoryKey = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_CATEGORY_LABEL: Record<FeedbackCategoryKey, string> = { BUG: "遇到问题", SUGGESTION: "功能建议", INACCURATE: "分析结果不准", OTHER: "其他" };
export const FEEDBACK_LIMITS = { message: 1000, snippet: 2000, perDay: 10 } as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `最多 ${max} 个字`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/**
 * 反馈输入。`snippet` 只有用户主动粘贴才有：系统不会自动附带聊天、对象或分析内容。
 */
export const feedbackInputSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES, { message: "请选择反馈类型" }),
  message: z.string().trim().min(1, "请写下你想反馈的内容").max(FEEDBACK_LIMITS.message, `反馈最多 ${FEEDBACK_LIMITS.message} 个字`),
  snippet: optionalText(FEEDBACK_LIMITS.snippet),
});
export type FeedbackInput = z.input<typeof feedbackInputSchema>;
