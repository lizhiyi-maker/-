import { z } from "zod";

export const DATA_KIND_LABEL = {
  CONTINUOUS: "连续聊天",
  CURATED: "精选片段",
  UNCERTAIN: "不确定",
} as const;

export const DATA_KIND_HINT = {
  CONTINUOUS: "一段没有挑选过的完整对话，可用于判断主动频率与稳定性",
  CURATED: "你挑出来的几段话，只用于具体表达的分析，不推断整体频率和稳定性",
  UNCERTAIN: "不确定是否完整，按精选片段的方式使用",
} as const;

export const BATCH_STATUS_LABEL = {
  UPLOADING: "待提交资料",
  RECOGNIZING: "识别中",
  PENDING_CONFIRM: "待确认",
  CONFIRMED: "已保存",
} as const;

export const SPEAKER_LABEL = { SELF: "我", OTHER: "对方", UNKNOWN: "未确认" } as const;
export const MESSAGE_TYPE_LABEL = { TEXT: "文字", IMAGE: "图片", VOICE: "语音", SYSTEM: "系统提示", OTHER: "其他" } as const;
export const TIME_PRECISION_LABEL = {
  SECOND: "精确到秒",
  MINUTE: "精确到分",
  DATE: "仅日期",
  ORDER_ONLY: "仅顺序",
  UNKNOWN: "时间未知",
} as const;

export const createBatchSchema = z.object({
  platform: z.enum(["WECHAT", "DOUYIN", "OTHER"]),
  dataKind: z.enum(["CONTINUOUS", "CURATED", "UNCERTAIN"]),
});

export const dataKindSchema = z.enum(["CONTINUOUS", "CURATED", "UNCERTAIN"]);
export const roleSchema = z.enum(["SELF", "OTHER"]);

export const editMessageSchema = z.object({
  content: z.string().trim().min(1, "内容不能为空；不需要的内容请选择丢弃").max(5000, "单条消息最多 5000 字").optional(),
  speaker: z.enum(["SELF", "OTHER", "UNKNOWN"]).optional(),
  occurredAt: z.date().nullable().optional(),
  timePrecision: z.enum(["SECOND", "MINUTE", "DATE", "ORDER_ONLY", "UNKNOWN"]).optional(),
});

export type CreateBatchInput = z.input<typeof createBatchSchema>;
export type EditMessageInput = z.input<typeof editMessageSchema>;
