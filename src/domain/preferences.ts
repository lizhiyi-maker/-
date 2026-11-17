import { z } from "zod";
import scoring from "../../config/scoring/v0.json";

/** 维度与重要程度范围来自评分配置（唯一来源），此处不重复定义。 */
export const DIMENSIONS = scoring.dimensions as readonly { key: string; label: string }[];
export const IMPORTANCE = scoring.importance;

export const EXPECTATION_LABEL = {
  SERIOUS: "认真发展、奔着长期",
  GET_TO_KNOW: "先了解，再看",
  CASUAL: "轻松相处",
  UNDECIDED: "暂时还不确定",
} as const;
export const CONTACT_FREQUENCY_LABEL = {
  DAILY: "几乎每天联系",
  EVERY_FEW_DAYS: "隔几天联系",
  WEEKLY: "每周几次",
  RELAXED: "随缘，不强求",
} as const;
export const PACE_LABEL = { SLOW: "慢一点", MODERATE: "适中", FAST: "积极推进" } as const;

const importanceSchema = z
  .record(z.string(), z.number().int().min(IMPORTANCE.min).max(IMPORTANCE.max))
  .superRefine((value, ctx) => {
    const keys = DIMENSIONS.map((d) => d.key);
    const given = Object.keys(value);
    for (const k of keys) if (!(k in value)) ctx.addIssue({ code: "custom", message: `缺少维度：${k}` });
    for (const k of given) if (!keys.includes(k)) ctx.addIssue({ code: "custom", message: `未知维度：${k}` });
  });

export const preferenceInputSchema = z.object({
  expectation: z.enum(["SERIOUS", "GET_TO_KNOW", "CASUAL", "UNDECIDED"]).nullable().optional(),
  contactFrequency: z.enum(["DAILY", "EVERY_FEW_DAYS", "WEEKLY", "RELAXED"]).nullable().optional(),
  pace: z.enum(["SLOW", "MODERATE", "FAST"]).nullable().optional(),
  importance: importanceSchema,
});

export type PreferenceInput = z.input<typeof preferenceInputSchema>;

export interface PreferenceValues {
  expectation: string | null;
  contactFrequency: string | null;
  pace: string | null;
  importance: Record<string, number>;
}

/** 公开的默认配置：不预设期待与节奏，五个维度同等重要。 */
export const DEFAULT_PREFERENCES: PreferenceValues = {
  expectation: null,
  contactFrequency: null,
  pace: null,
  importance: Object.fromEntries(DIMENSIONS.map((d) => [d.key, IMPORTANCE.default])),
};
