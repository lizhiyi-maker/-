import { z } from "zod";

/** 线下事件的类型：见面、通话、取消安排、补充事实（docs/business/analysis-spec.md §2、GLOSSARY“线下事件”）。 */
export const EVENT_KINDS = ["MEET", "CALL", "CANCELLED", "FACT_NOTE"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  MEET: "见面",
  CALL: "通话",
  CANCELLED: "取消安排",
  FACT_NOTE: "补充事实",
};

export const EVENT_LIMITS = { facts: 500, note: 1000 } as const;

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** 北京时间的“今天”，格式 YYYY-MM-DD。 */
export function todayInBeijing(now: Date): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → 当天 UTC 零点（只保留日期；展示与情境计算都按北京时间日期，见 evidence.ts）。 */
export function parseEventDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

export const toDateInput = (d: Date) => d.toISOString().slice(0, 10);

const factsText = z.string().trim().min(1, "请填写发生了什么（只写事实）").max(EVENT_LIMITS.facts, `事实最多 ${EVENT_LIMITS.facts} 个字`);
const noteText = z
  .string()
  .trim()
  .max(EVENT_LIMITS.note, `个人感受最多 ${EVENT_LIMITS.note} 个字`)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

/**
 * 事实与个人感受分开：`facts`/`kind`/`occurredOn` 是可被报告引用的事实（修改会产生新修订），
 * `personalNote` 是用户自己的感受，只在本产品内展示，不发送给 AI 服务商，也不能当作对方的客观事实。
 */
export const eventInputSchema = z.object({
  kind: z.enum(EVENT_KINDS, { message: "请选择事件类型" }),
  occurredOn: z.string().refine((v) => parseEventDate(v) !== null, "请填写事件发生的日期"),
  facts: factsText,
  personalNote: noteText,
});

export const eventPatchSchema = eventInputSchema.partial();

export type EventInput = z.input<typeof eventInputSchema>;
export type EventPatch = z.input<typeof eventPatchSchema>;
