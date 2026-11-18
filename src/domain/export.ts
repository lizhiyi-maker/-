import { DATA_KIND_LABEL, MESSAGE_TYPE_LABEL, SPEAKER_LABEL } from "@/domain/imports";
import { PLATFORM_LABEL } from "@/domain/people";

export interface ChatTextMessage {
  speaker: keyof typeof SPEAKER_LABEL;
  type: keyof typeof MESSAGE_TYPE_LABEL;
  /** 当前修订的内容 */
  content: string;
  occurredAt: Date | null;
  timePrecision: "SECOND" | "MINUTE" | "DATE" | "ORDER_ONLY" | "UNKNOWN";
}

export interface ChatTextBatch {
  platform: keyof typeof PLATFORM_LABEL;
  dataKind: keyof typeof DATA_KIND_LABEL;
  confirmedAt: Date | null;
  messages: ChatTextMessage[];
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const bj = (d: Date) => new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ（北京时间的各个字段）

/** 时间按精度显示；没有可靠时间就明确写“时间未知”，不猜测、不补全。 */
export function timeLabel(m: Pick<ChatTextMessage, "occurredAt" | "timePrecision">): string {
  if (!m.occurredAt) return "时间未知";
  const iso = bj(m.occurredAt);
  if (m.timePrecision === "SECOND") return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  if (m.timePrecision === "MINUTE") return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  if (m.timePrecision === "DATE") return iso.slice(0, 10);
  return "时间未知";
}

/**
 * 把一个对象已保存的聊天整理成可读文本（数据导出用，纯函数）。按批次分组，每条一行：`[时间] 发言人：内容`。
 * 发言人用“我/对方/未确认”，不猜测；多行消息的后续行缩进，避免与下一条消息混淆。
 */
export function formatChatText(nickname: string, batches: ChatTextBatch[]): string {
  const lines = [`# 与“${nickname}”的聊天资料（导出自关系工作台）`, "# 时间均为北京时间；“时间未知”表示资料里没有可靠的时间，没有被猜测或补全。", ""];
  const nonEmpty = batches.filter((b) => b.messages.length > 0);
  if (nonEmpty.length === 0) lines.push("（还没有保存的聊天资料）");
  nonEmpty.forEach((b, i) => {
    const saved = b.confirmedAt ? ` · 保存于 ${bj(b.confirmedAt).slice(0, 16).replace("T", " ")}` : "";
    lines.push(`== 第 ${i + 1} 批：${PLATFORM_LABEL[b.platform]} · ${DATA_KIND_LABEL[b.dataKind]}${saved} ==`);
    for (const m of b.messages) {
      const kind = m.type === "TEXT" ? "" : `（${MESSAGE_TYPE_LABEL[m.type]}）`;
      const [first, ...rest] = m.content.replace(/\r\n?/g, "\n").split("\n");
      lines.push(`[${timeLabel(m)}] ${SPEAKER_LABEL[m.speaker]}${kind}：${first}`, ...rest.map((r) => `    ${r}`));
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}
