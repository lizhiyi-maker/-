import { Badge } from "@/components/ui/card";
import { SPEAKER_LABEL } from "@/domain/imports";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MessageView {
  id: string;
  speaker: "SELF" | "OTHER" | "UNKNOWN";
  type: "TEXT" | "IMAGE" | "VOICE" | "SYSTEM" | "OTHER";
  content: string;
  occurredAt: Date | null;
  timePrecision: "SECOND" | "MINUTE" | "DATE" | "ORDER_ONLY" | "UNKNOWN";
  recognition: "RECOGNIZED" | "UNCERTAIN" | "USER_EDITED";
}

/** 未知时间与真实时间分开展示：没有可靠时间就明确写“时间未知”。 */
export function messageTimeText(m: Pick<MessageView, "occurredAt" | "timePrecision">): string {
  if (!m.occurredAt) return "时间未知";
  if (m.timePrecision === "DATE") return `${formatDate(m.occurredAt)}（仅日期）`;
  if (m.timePrecision === "SECOND" || m.timePrecision === "MINUTE") return formatDateTime(m.occurredAt);
  return "时间未知";
}

const TYPE_HINT: Record<MessageView["type"], string | null> = {
  TEXT: null,
  IMAGE: "图片（内容未提供）",
  VOICE: "语音（内容未提供）",
  SYSTEM: "系统提示",
  OTHER: "其他类型",
};

/** 只读的消息列表（已保存的资料）。 */
export function MessageList({ messages }: { messages: MessageView[] }) {
  return (
    <ol className="space-y-2" data-testid="message-list">
      {messages.map((m) => (
        <li key={m.id} className={cn("flex gap-2", m.speaker === "SELF" && "flex-row-reverse")}>
          <div className={cn("max-w-[85%] rounded-lg border px-3 py-2 text-sm", m.speaker === "SELF" ? "bg-primary/5" : "bg-card")}>
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Badge tone={m.speaker === "UNKNOWN" ? "warn" : "muted"}>{SPEAKER_LABEL[m.speaker]}</Badge>
              <span>{messageTimeText(m)}</span>
              {TYPE_HINT[m.type] && <Badge>{TYPE_HINT[m.type]}</Badge>}
              {m.recognition === "USER_EDITED" && <Badge tone="primary">已修改</Badge>}
            </div>
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
