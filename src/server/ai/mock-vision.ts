import { parseChatText } from "@/domain/chat/parser";
import type { VisionInput, VisionModel, VisionResult } from "./vision";

/** 模拟识别：读取 PNG 里嵌入的 tEXt 块 "mock-transcript"（base64 的 UTF-8 文本），再用文本解析器整理。 */
export const TRANSCRIPT_CHUNK = "mock-transcript";

function readPngText(bytes: Uint8Array, keyword: string): string | null {
  const buf = Buffer.from(bytes);
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0 && data.toString("latin1", 0, nul) === keyword) return data.toString("latin1", nul + 1);
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  return null;
}


/**
 * 控制标记（仅模拟模型识别，用于演示与测试）：
 *  - `[[FAIL]]`：模拟服务商失败；
 *  - `[[SLOW:毫秒]]`：模拟耗时，用于验证“离开页面后任务继续、刷新可恢复进度”。
 */
export function createMockVision(): VisionModel {
  return {
    id: "mock-vision-v0",
    simulated: true,
    async recognize({ bytes, contentType }: VisionInput): Promise<VisionResult> {
      if (contentType !== "image/png") throw new Error("模拟识别只支持内嵌转写的 PNG");
      const encoded = readPngText(bytes, TRANSCRIPT_CHUNK);
      if (encoded === null) throw new Error("模拟识别：图片中没有内嵌转写文本");
      let text = Buffer.from(encoded, "base64").toString("utf8");

      const slow = /\[\[SLOW:(\d{1,6})\]\]/.exec(text);
      if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
      if (text.includes("[[FAIL]]")) throw new Error("模拟识别：服务商失败");
      text = text.replace(/\[\[[A-Z]+(?::\d+)?\]\]/g, "");

      return { messages: parseChatText(text).messages };
    },
  };
}
