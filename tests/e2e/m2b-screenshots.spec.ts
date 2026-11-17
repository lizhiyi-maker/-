import { expect, test, type Page } from "@playwright/test";
import { makeChatScreenshot } from "./chat-image";
import { acceptConsent, createPerson, freshUser, uniqueName, waitForHydration } from "./helpers";

async function startScreenshotBatch(page: Page, personId: string) {
  await page.goto(`/people/${personId}/import/new?mode=screenshot`);
  await waitForHydration(page);
  await page.getByRole("button", { name: "下一步：上传截图" }).click();
  await expect(page.getByRole("heading", { name: "上传聊天截图" })).toBeVisible();
  await waitForHydration(page);
}

const png = (name: string, buffer: Buffer) => ({ name, mimeType: "image/png", buffer });

test("上传多张模拟截图 → 开始识别 → 刷新后进度仍在 → 确认身份 → 保存 → 原图不可再访问", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());
  await startScreenshotBatch(page, personId);

  const shot1 = await makeChatScreenshot(page, ["阿青：今晚吃什么", "我：火锅怎么样", "阿青：好呀", "我：七点见"]);
  // 第二张与第一张重叠两条消息，并模拟耗时 4 秒，用来验证识别在后台进行、刷新后进度仍在
  const shot2 = await makeChatScreenshot(page, ["阿青：好呀", "我：七点见", "阿青：不见不散"], "[[SLOW:4000]]");

  const input = page.getByTestId("screenshot-input");
  await input.setInputFiles([png("a.png", shot1), png("b.png", shot2)]);
  await expect(page.getByTestId("shot-list").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("upload-items")).toContainText("已添加");

  // 相同文件重复上传：提示并跳过；非图片被拒绝；都不会增加截图
  await input.setInputFiles([png("a-again.png", shot1)]);
  await expect(page.getByTestId("upload-items")).toContainText("重复，已跳过");
  await input.setInputFiles([{ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image at all") }]);
  await expect(page.getByTestId("upload-items")).toContainText("只支持 PNG、JPEG、WebP");
  await expect(page.getByTestId("shot-list").getByRole("listitem")).toHaveCount(2);

  // 首次向 AI 服务商发送内容之前必须先同意；同意前看不到“开始识别”
  await expect(page.getByRole("button", { name: "开始识别" })).toHaveCount(0);
  await acceptConsent(page);

  // 上传不会自动识别，也不扣额度
  await expect(page.getByTestId("quota-hint")).toContainText("将识别 2 张");
  await expect(page.getByTestId("quota-hint")).toContainText("当前剩余 120 张");

  await page.getByRole("button", { name: "开始识别" }).click();
  await expect(page.getByTestId("progress-card")).toBeVisible();

  // 刷新页面：进度来自服务端，不会丢
  await page.reload();
  await expect(page.getByTestId("progress-card")).toBeVisible();
  await expect(page.getByTestId("progress-text")).toContainText("/ 2 张");

  // 识别完成后进入确认页（轮询刷新）
  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("preview-list").getByRole("listitem")).toHaveCount(5); // 重叠的两条只保留一份
  await expect(page.getByTestId("originals-card")).toContainText("保存后原图会立即停止访问并被删除");

  // 核对原图：登录状态下可以通过短时链接查看；未登录一律 404
  await page.getByText(/查看原图/).click();
  const src = await page.getByTestId("originals-card").locator("img").first().getAttribute("src");
  expect(src).toMatch(/^\/api\/files\/.+\..+/);
  expect((await page.request.get(src!)).status()).toBe(200);
  const anon = await browser.newContext();
  expect((await anon.request.get(`http://127.0.0.1:3100${src}`)).status()).toBe(404);
  await anon.close();

  // 确认身份并保存
  await page.getByRole("button", { name: "将“阿青”设为对方" }).click();
  await expect(page.getByRole("button", { name: "将“阿青”设为对方" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "将“我”设为我" }).click();
  await expect(page.getByRole("button", { name: "将“我”设为我" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByTestId("saved-notice")).toContainText("已保存 5 条消息");

  // 保存后原图立即不可访问（旧链接失效）
  expect((await page.request.get(src!)).status()).toBe(404);

  // 额度：两张成功识别，各扣一次
  await page.goto("/me");
  await expect(page.getByTestId("quota-screenshot")).toHaveText("118");
  await ctx.close();
});

test("部分识别失败：失败的不扣额度，可以跳过后用已识别的内容继续", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());
  await startScreenshotBatch(page, personId);

  const good = await makeChatScreenshot(page, ["阿青：在吗", "我：在"]);
  const bad = await makeChatScreenshot(page, ["阿青：看不清"], "[[FAIL]]");
  await page.getByTestId("screenshot-input").setInputFiles([png("good.png", good), png("bad.png", bad)]);
  await expect(page.getByTestId("shot-list").getByRole("listitem")).toHaveCount(2);
  await acceptConsent(page);
  await page.getByRole("button", { name: "开始识别" }).click();

  await expect(page.getByTestId("progress-text")).toContainText("有 1 张识别失败", { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "重试失败的 1 张" })).toBeVisible();
  await page.getByRole("button", { name: "跳过失败的，继续" }).click();

  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preview-list").getByRole("listitem")).toHaveCount(2);

  await page.goto("/me");
  await expect(page.getByTestId("quota-screenshot")).toHaveText("119"); // 只为成功的一张扣额度
  await ctx.close();
});

test("放弃截图批次：已预留的识别额度退还", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());
  await startScreenshotBatch(page, personId);
  const slow = await makeChatScreenshot(page, ["阿青：慢一点"], "[[SLOW:20000]]");
  await page.getByTestId("screenshot-input").setInputFiles([png("slow.png", slow)]);
  await expect(page.getByTestId("shot-list").getByRole("listitem")).toHaveCount(1);
  await acceptConsent(page);
  await page.getByRole("button", { name: "开始识别" }).click();
  await expect(page.getByTestId("progress-card")).toBeVisible();

  await page.goto("/me");
  await expect(page.getByTestId("quota-screenshot")).toHaveText("119"); // 识别中：已预留 1 张

  await page.goBack();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "放弃这批资料" }).click();
  await expect(page).toHaveURL(/tab=chats/); // 等删除操作完成并跳转，不能在请求进行中就离开页面
  await page.goto("/me");
  await expect(page.getByTestId("quota-screenshot")).toHaveText("120");
  await ctx.close();
});
