import { expect, test } from "@playwright/test";
import { acceptConsent, createPerson, devLogin, freshUser, importTextChat, uniqueName, waitForHydration } from "./helpers";

const CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？这句是只属于聊天资料的内容\n[2026-03-01 20:02] 我：加班";

test("用户反馈：用户提交（主动附片段）→ 管理员在后台看到（手机号脱敏）→ 标记已处理 → 用户看到已处理", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const name = uniqueName("反馈");
  const personId = await createPerson(page, name);
  await importTextChat(page, personId, CHAT); // 有聊天数据，用来确认反馈不会自动带出

  await page.goto("/me");
  await page.getByTestId("feedback-link").click();
  await expect(page.getByRole("heading", { name: "意见反馈" })).toBeVisible();
  await waitForHydration(page);
  const message = `报告页的建议不太对 ${uniqueName("m")}`;
  await page.getByLabel("反馈类型").selectOption("INACCURATE");
  await page.getByLabel("想反馈的内容").fill(message);
  await page.getByLabel(/附上一段文字/).fill("用户自己粘贴的那一句");
  await page.getByRole("button", { name: "提交反馈" }).click();
  await expect(page.getByText("已收到，谢谢你的反馈")).toBeVisible();
  await expect(page.getByTestId("my-feedback")).toContainText(message);
  await expect(page.getByTestId("my-feedback")).toContainText("待处理");

  // 管理员：看到反馈和主动附上的片段，手机号脱敏，看不到聊天与对象
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await devLogin(admin, "admin");
  await admin.goto("/admin/feedback");
  const item = admin.getByTestId("feedback-item").filter({ hasText: message });
  await expect(item).toBeVisible();
  await expect(item).toContainText("分析结果不准");
  await expect(item).toContainText("用户自己粘贴的那一句");
  await expect(item).toContainText(/\d{3}\*{4}\d{4}/);
  const adminText = await admin.getByTestId("feedback-list").innerText();
  expect(adminText).not.toContain("只属于聊天资料的内容");
  expect(adminText).not.toContain(name);
  await item.getByRole("button", { name: "标记已处理" }).click();
  // 注意“标记已处理”按钮文字里也有“已处理”：要等按钮消失才说明状态已更新
  await expect(admin.getByTestId("feedback-item").filter({ hasText: message }).getByRole("button", { name: "标记已处理" })).toHaveCount(0);
  await adminCtx.close();

  await page.goto("/me/feedback");
  await expect(page.getByTestId("my-feedback")).toContainText("已处理");
  await ctx.close();
});

test("后台运营页：任务状态、成本、用户反馈三页可见；只读、不含聊天内容；成本如实标注模拟与单价未核实；普通用户 404", async ({ browser }) => {
  test.setTimeout(180_000);
  // 先产生真实的任务与用量：一个用户完成一次分析（独立 worker 处理）
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName("运营"));
  await importTextChat(page, personId, CHAT);
  await page.goto(`/people/${personId}?tab=analysis`);
  await acceptConsent(page);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "FRESH", { timeout: 45_000 });

  // 普通用户不能进后台
  for (const path of ["/admin/tasks", "/admin/costs", "/admin/feedback"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
  }
  await ctx.close();

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await devLogin(admin, "admin");

  await admin.goto("/admin/tasks");
  await expect(admin.getByTestId("tasks-analysis")).toContainText("成功");
  await expect(admin.getByTestId("tasks-stuck")).toBeVisible();
  await expect(admin.getByTestId("task-row").first()).toBeVisible();
  const tasksText = await admin.locator("main, body").first().innerText();
  expect(tasksText).not.toContain("只属于聊天资料的内容");
  expect(await admin.getByRole("button").allInnerTexts()).not.toEqual(expect.arrayContaining([expect.stringMatching(/重试|取消|退款/)])); // 只读：没有操作按钮

  await admin.goto("/admin/costs");
  await expect(admin.getByTestId("prices-unverified")).toContainText("单价未核实");
  await expect(admin.getByTestId("all-simulated")).toContainText("模拟模型");
  await expect(admin.getByTestId("cost-by-kind")).toContainText("分析·提取事实");
  await expect(admin.getByTestId("cost-by-model")).toContainText("（模拟）");
  await expect(admin.getByTestId("cost-average")).toContainText("每次分析的平均成本");
  expect(await admin.locator("body").innerText()).not.toContain("只属于聊天资料的内容");

  await admin.goto("/admin/feedback");
  await expect(admin.getByRole("navigation", { name: "后台导航" })).toContainText("任务状态");
  await adminCtx.close();
});
