import type { Page } from "@playwright/test";
import { embedTranscript } from "../support/png";

/**
 * 用 Playwright 渲染一张虚构的聊天截图（微信风格的左右气泡），再把“转写文本”嵌入 PNG，
 * 供模拟视觉模型读取。不含任何真实资料。
 * lines 使用 “发言人：内容” 格式；以 “我：” 开头的显示在右侧。
 */
export async function makeChatScreenshot(page: Page, lines: string[], extraTranscript = ""): Promise<Buffer> {
  const bubbles = lines
    .map((l) => {
      const [who, ...rest] = l.split("：");
      const text = rest.join("：");
      const mine = who === "我";
      return `<div style="display:flex;justify-content:${mine ? "flex-end" : "flex-start"};margin:8px 0">
        <div style="max-width:70%;padding:8px 12px;border-radius:8px;background:${mine ? "#95ec69" : "#fff"};font-size:16px">${text.replace(/</g, "&lt;")}</div>
      </div>`;
    })
    .join("");
  const shot = await page.context().newPage();
  try {
    await shot.setViewportSize({ width: 360, height: 640 });
    await shot.setContent(`<body style="margin:0;padding:12px;background:#ededed;font-family:sans-serif">${bubbles}</body>`);
    const png = await shot.screenshot({ type: "png" });
    return Buffer.from(embedTranscript(png, [...lines, extraTranscript].filter(Boolean).join("\n")));
  } finally {
    await shot.close();
  }
}
