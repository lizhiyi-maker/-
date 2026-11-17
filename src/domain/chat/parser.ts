import type { MessageType, ParsedMessage, ParseResult, TimePrecision } from "./types";

/**
 * 通用聊天文本解析器（id: generic-text-v1）。样本见 samples/chat-text/。
 *
 * 支持两种可明确识别的格式：
 *  1. 头部格式：独占一行的 "发言人 [日期] 时间"，其后若干行为内容；可穿插独占一行的日期分隔行。
 *  2. 行内格式：每行 "[日期 时间] 发言人：内容"（方括号部分可省略）。
 * 原则：不猜测。没有完整日期就没有时间；无法归属的行标为不确定，交给用户确认。
 * 聊天中的任何文字（包括"指令"）都只是待分析资料，不在此处被解释。
 */
export const GENERIC_PARSER_ID = "generic-text-v1";

const DATE = String.raw`(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?`;
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?`;
const NAME = String.raw`[^\s:：\[\]【】"“”]{1,20}`;

const RE_DATE_SEP = new RegExp(String.raw`^\s*[-—=~\s]*${DATE}(?:\s*(?:星期.|周.))?[-—=~\s]*$`);
const RE_HEADER = new RegExp(String.raw`^(${NAME})\s+(?:${DATE}\s+)?${TIME}\s*$`);
const RE_INLINE = new RegExp(String.raw`^\s*(?:[\[【]\s*(?:${DATE})?\s*(?:${TIME})?\s*[\]】]\s*)?(${NAME})\s*[:：]\s*(.*)$`);
const RE_SYSTEM = /(撤回了一条消息|拍了拍)/;

interface DateParts {
  y: number;
  m: number;
  d: number;
}

function validDate(y: number, m: number, d: number) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1970 && y <= 2100;
}

/** 聊天时间按北京时间（UTC+8）解释。 */
function resolveTime(
  date: DateParts | null,
  time: { h: number; mi: number; s: number | null } | null,
): { occurredAt: Date | null; precision: TimePrecision } {
  if (!date || !validDate(date.y, date.m, date.d)) return { occurredAt: null, precision: "UNKNOWN" };
  if (!time) return { occurredAt: new Date(Date.UTC(date.y, date.m - 1, date.d, -8)), precision: "DATE" };
  if (time.h > 23 || time.mi > 59 || (time.s ?? 0) > 59) return { occurredAt: null, precision: "UNKNOWN" };
  return {
    occurredAt: new Date(Date.UTC(date.y, date.m - 1, date.d, time.h - 8, time.mi, time.s ?? 0)),
    precision: time.s === null ? "MINUTE" : "SECOND",
  };
}

function contentType(content: string): MessageType {
  const t = content.trim();
  if (/^\[(图片|照片)\]$/.test(t)) return "IMAGE";
  if (/^\[语音.*\]$/.test(t)) return "VOICE";
  if (/^\[(视频|文件|链接|表情|动画表情|位置|名片|红包|转账)[^\]]*\]$/.test(t)) return "OTHER";
  return "TEXT";
}

const num = (s: string | undefined) => (s === undefined ? null : Number(s));

function dateFrom(g: (string | undefined)[], at: number): DateParts | null {
  return g[at] ? { y: Number(g[at]), m: Number(g[at + 1]), d: Number(g[at + 2]) } : null;
}

function timeFrom(g: (string | undefined)[], at: number) {
  return g[at] ? { h: Number(g[at]), mi: Number(g[at + 1]), s: num(g[at + 2]) } : null;
}

export function parseChatText(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const messages: ParsedMessage[] = [];

  // 以出现头部行为准选择格式：有头部行则按头部格式，否则按行内格式
  const headerMode = lines.some((l) => RE_HEADER.test(l.trim()));
  let ctxDate: DateParts | null = null;

  let open: { line: number; label: string; date: DateParts | null; time: ReturnType<typeof timeFrom>; body: string[] } | null = null;

  const flush = () => {
    if (!open) return;
    const content = open.body.join("\n").trim();
    const t = resolveTime(open.date ?? ctxDate, open.time);
    messages.push({
      line: open.line,
      speakerLabel: open.label,
      content,
      type: content ? contentType(content) : "TEXT",
      occurredAt: t.occurredAt,
      timePrecision: t.precision,
      uncertain: content === "",
      reason: content === "" ? "这条消息没有内容" : undefined,
    });
    open = null;
  };

  const stray = (line: number, raw: string) =>
    messages.push({
      line,
      speakerLabel: null,
      content: raw.trim(),
      type: "TEXT",
      occurredAt: null,
      timePrecision: "UNKNOWN",
      uncertain: true,
      reason: "无法判断这一行是谁说的、属于哪条消息",
    });

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === "") return;

    const sep = RE_DATE_SEP.exec(line);
    if (sep) {
      flush();
      ctxDate = { y: Number(sep[1]), m: Number(sep[2]), d: Number(sep[3]) };
      return;
    }

    if (RE_SYSTEM.test(line) && line.length <= 40) {
      flush();
      messages.push({
        line: lineNo,
        speakerLabel: null,
        content: line,
        type: "SYSTEM",
        occurredAt: null,
        timePrecision: "UNKNOWN",
        uncertain: false,
      });
      return;
    }

    if (headerMode) {
      const h = RE_HEADER.exec(line);
      if (h) {
        flush();
        open = { line: lineNo, label: h[1], date: dateFrom(h, 2), time: timeFrom(h, 5), body: [] };
      } else if (open) {
        open.body.push(line);
      } else {
        stray(lineNo, line);
      }
      return;
    }

    const m = RE_INLINE.exec(line);
    if (m && !m[8].startsWith("//")) {
      flush();
      open = { line: lineNo, label: m[7], date: dateFrom(m, 1), time: timeFrom(m, 4), body: [m[8]] };
      flush();
    } else {
      flush();
      stray(lineNo, line);
    }
  });
  flush();

  const counts = new Map<string, number>();
  for (const m of messages) if (m.speakerLabel) counts.set(m.speakerLabel, (counts.get(m.speakerLabel) ?? 0) + 1);

  return {
    parserId: GENERIC_PARSER_ID,
    messages,
    labels: [...counts].map(([label, count]) => ({ label, count })),
  };
}
