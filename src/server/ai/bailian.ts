import { z } from "zod";
import type { ParsedMessage, TimePrecision } from "@/domain/chat/types";
import type { AnalysisModel, CallContext, ExtractInput, InterpretInput, ModelEvent, ModelMessage } from "./analysis-model";
import { BAILIAN_ANALYSIS_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT, INTERPRET_SYSTEM_PROMPT, VISION_SYSTEM_PROMPT } from "./bailian-prompts";
import type { VisionInput, VisionModel, VisionResult } from "./vision";

// 阿里云百炼（通义千问）适配器：走 OpenAI 兼容的 chat/completions 接口，用 Node 自带 fetch，不引入 SDK。
// ⏳ 请求/响应格式依据对该兼容接口的了解，没有在真实服务上联调过；默认地址、模型名、图片大小与限流以百炼控制台与文档为准。
// 单测用注入的假 fetch 覆盖：请求构造、用量上报、错误处理（不泄露密钥与聊天内容）、输出解析。

export const DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export interface BailianOptions {
  apiKey: string;
  /** 文本（分析）模型名。由环境变量提供，代码里没有默认值：以你在百炼控制台核实过的为准。 */
  textModel: string;
  /** 视觉（截图识别）模型名。同上。 */
  visionModel: string;
  baseUrl?: string;
  /** 测试注入；默认全局 fetch */
  fetch?: typeof fetch;
  /** 单次请求超时（毫秒）；默认文本 120 秒、视觉 90 秒 */
  timeoutMs?: number;
}

/**
 * 百炼调用失败。只带稳定的错误码（HTTP 状态、服务商给的错误码、或本地原因），**不带**响应体、请求内容或原始异常：
 * 它们可能含聊天内容、手机号或密钥，而错误会被框架记入日志、并以错误码形式出现在后台任务页。
 */
export class BailianError extends Error {
  constructor(public readonly code: string) {
    super(`百炼调用失败：${code}`);
    this.name = "BailianError";
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

interface ChatCall {
  model: string;
  system: string;
  /** 用户消息：字符串（文本模型）或内容片段数组（含图片） */
  user: string | unknown[];
  timeoutMs: number;
}

async function chat(opts: BailianOptions, call: ChatCall, ctx: CallContext | undefined): Promise<string | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${(opts.baseUrl ?? DEFAULT_BAILIAN_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: call.model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new BailianError(timedOut ? "TIMEOUT" : "REQUEST_FAILED"); // 有意丢弃原始异常，见 BailianError 的注释
  }

  try {
    if (!res.ok) {
      let providerCode: string | undefined;
      try {
        const c = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
        if (typeof c === "string" && SAFE_CODE.test(c)) providerCode = c; // 例如 data_inspection_failed（内容安全拦截）
      } catch {
        /* 响应体不是 JSON：只用状态码 */
      }
      throw new BailianError(providerCode ? `HTTP_${res.status}:${providerCode}` : `HTTP_${res.status}`);
    }
    let body: { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      body = await res.json();
    } catch {
      if (timedOut) throw new BailianError("TIMEOUT");
      return undefined; // 200 但不是 JSON：交给调用方的校验器判为无效输出
    }
    const u = body?.usage;
    if (ctx && typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number") {
      ctx.reportUsage({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens });
    }
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } catch (e) {
    if (e instanceof BailianError) throw e;
    throw new BailianError(timedOut ? "TIMEOUT" : "REQUEST_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

/** 解析模型返回的 JSON；容忍 ```json 代码块与前后多余文字。解析不了返回 undefined。 */
function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// ───────── 分析模型 ─────────

const pad = (n: number) => String(n).padStart(2, "0");
/** 北京时间（UTC+8）的日期与时间字符串 */
function beijing(d: Date): { date: string; time: string } {
  const b = new Date(d.getTime() + 8 * 3_600_000);
  return { date: `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`, time: `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}` };
}

function timeFor(m: ModelMessage): string | null {
  if (!m.occurredAt) return null;
  const { date, time } = beijing(m.occurredAt);
  if (m.timePrecision === "DATE") return date;
  if (m.timePrecision === "MINUTE" || m.timePrecision === "SECOND") return `${date} ${time}`;
  return null;
}

const messagePayload = (m: ModelMessage) => ({
  code: m.code,
  speaker: m.speaker.toLowerCase(), // self | other | unknown
  type: m.type.toLowerCase(),
  time: timeFor(m),
  source: m.dataKind.toLowerCase(), // continuous | curated | uncertain
  content: m.content,
});

const eventPayload = (e: ModelEvent) => ({ code: e.code, kind: e.kind, date: beijing(e.occurredOn).date.slice(0, 10), content: e.content });

export function createBailianAnalysisModel(opts: BailianOptions): AnalysisModel {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    id: `bailian:${opts.textModel}`,
    promptVersion: BAILIAN_ANALYSIS_PROMPT_VERSION,
    async extractFacts(input: ExtractInput, ctx?: CallContext) {
      const user = JSON.stringify({
        segment: { index: input.segmentIndex + 1, count: input.segmentCount },
        messages: input.messages.map(messagePayload),
        events: input.events.map(eventPayload),
      });
      const text = await chat(opts, { model: opts.textModel, system: EXTRACT_SYSTEM_PROMPT, user, timeoutMs }, ctx);
      // 解析不了就交给流水线的校验器：返回的东西不符合约定的结构，整次分析会以“事实无效”失败并退还额度
      return (parseJson(text) ?? null) as { facts: never[] };
    },
    async interpret(input: InterpretInput, ctx?: CallContext) {
      const user = JSON.stringify({
        facts: input.facts.map((f) => ({ dimension: f.dimension, text: f.text, refs: f.refs, polarity: f.polarity, ...(f.signal ? { signal: f.signal } : {}) })),
        scope: input.scope,
        preferences: input.preferences,
        userContext: input.userContext,
      });
      const text = await chat(opts, { model: opts.textModel, system: INTERPRET_SYSTEM_PROMPT, user, timeoutMs }, ctx);
      return parseJson(text) ?? null; // 同上：不可信，由 validateModelOutput 校验
    },
  };
}

// ───────── 视觉模型 ─────────

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const visionSchema = z.object({
  messages: z
    .array(
      z.object({
        side: z.enum(["left", "right", "center", "unknown"]),
        type: z.enum(["text", "image", "voice", "system", "other"]),
        text: z.string().max(5000),
        time: z.string().nullable().optional(),
        uncertain: z.boolean().optional(),
        reason: z.string().max(200).optional(),
      }),
    )
    .max(300),
});

/** 只有完整日期 + 时间才算可靠时间（北京时间）；其余一律未知，不推算。 */
function parseVisionTime(time: string | null | undefined): { occurredAt: Date | null; precision: TimePrecision } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((time ?? "").trim());
  if (!m) return { occurredAt: null, precision: "UNKNOWN" };
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] === undefined ? undefined : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (s !== undefined && s > 59) || y < 1970 || y > 2100) return { occurredAt: null, precision: "UNKNOWN" };
  return { occurredAt: new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s ?? 0)), precision: s === undefined ? "MINUTE" : "SECOND" };
}

const TYPE_MAP = { text: "TEXT", image: "IMAGE", voice: "VOICE", system: "SYSTEM", other: "OTHER" } as const;
const PLACEHOLDER = { IMAGE: "[图片]", VOICE: "[语音]", OTHER: "[其他]" } as const;

export function createBailianVision(opts: BailianOptions): VisionModel {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return {
    id: `bailian:${opts.visionModel}`,
    async recognize(input: VisionInput, ctx?: CallContext): Promise<VisionResult> {
      if (!ALLOWED_IMAGE_TYPES.has(input.contentType)) throw new BailianError("UNSUPPORTED_IMAGE_TYPE");
      const dataUrl = `data:${input.contentType};base64,${Buffer.from(input.bytes).toString("base64")}`;
      const user = [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: "请按要求转写这张聊天截图，只输出 JSON。" },
      ];
      const text = await chat(opts, { model: opts.visionModel, system: VISION_SYSTEM_PROMPT, user, timeoutMs }, ctx);
      const parsed = visionSchema.safeParse(parseJson(text));
      // 识别没有“校验器”可以兜底：不是约定格式就当作系统失败（不扣用户额度），而不是返回一个空结果
      if (!parsed.success) throw new BailianError("INVALID_OUTPUT");

      const messages: ParsedMessage[] = parsed.data.messages.map((m, i) => {
        const type = TYPE_MAP[m.type];
        const speakerLabel = m.side === "left" ? "左侧" : m.side === "right" ? "右侧" : null;
        const { occurredAt, precision } = parseVisionTime(m.time);
        const text = m.text.trim();
        const content = text || (type === "TEXT" || type === "SYSTEM" ? "" : PLACEHOLDER[type]);

        let uncertain = m.uncertain ?? false;
        let reason = m.reason?.trim() || undefined;
        if (type === "TEXT" && !text) {
          uncertain = true;
          reason ??= "没有识别出文字";
        }
        if (type === "TEXT" && speakerLabel === null) {
          uncertain = true;
          reason ??= "无法确定是哪一侧发出的";
        }
        return { line: i + 1, speakerLabel, content, type, occurredAt, timePrecision: precision, uncertain, ...(reason ? { reason } : {}) };
      });
      return { messages };
    },
  };
}
