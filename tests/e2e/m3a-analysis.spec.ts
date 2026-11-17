import { expect, test, type Page } from "@playwright/test";
import { acceptConsent, createPerson, freshUser, importTextChat, uniqueName, waitForHydration } from "./helpers";

const CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班\n[2026-03-02 20:00] 阿青：周末有什么打算吗？\n[2026-03-02 20:03] 我：还没想好";

async function openAnalysis(page: Page, personId: string) {
  await page.goto(`/people/${personId}?tab=analysis`);
}

/** 点击开始分析并等待报告出现（模拟模型很快；报告由独立 worker 生成）。 */
async function runAnalysis(page: Page, personId: string, buttonName = "开始分析") {
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  // 重新分析时页面上本来就有旧报告，所以要等“新报告变为最新”（进行中页面会自动刷新）
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "FRESH", { timeout: 45_000 });
  await openAnalysis(page, personId);
}

test("同意 → 开始分析 → 查看报告并展开证据；新增资料后“有新资料待分析”；修改偏好后“偏好变更待更新”", async ({ browser }) => {
  test.setTimeout(150_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());

  // 没有资料时不能分析
  await openAnalysis(page, personId);
  await expect(page.getByTestId("consent-card")).toBeVisible();
  await acceptConsent(page);
  await expect(page.getByText("还没有可以分析的资料")).toBeVisible();

  await importTextChat(page, personId, CHAT);
  await page.getByRole("link", { name: "开始分析" }).click();
  await expect(page.getByTestId("consent-card")).toHaveCount(0); // 已同意，不再询问
  await runAnalysis(page, personId);

  // 报告：当前结论、五维、建议（≤3）、资料范围与规则版本；不展示概率或百分比
  const report = page.getByTestId("report");
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "FRESH");
  await expect(page.getByTestId("conclusion")).toContainText("基于 4 条消息");
  for (const label of ["双向投入", "了解意愿", "行动兑现", "沟通与边界", "意愿与节奏匹配"]) {
    await expect(report.getByRole("heading", { name: label })).toBeVisible();
  }
  expect(await page.getByTestId("suggestion").count()).toBeLessThanOrEqual(3);
  await expect(page.getByTestId("report-scope")).toContainText("实验规则");
  await expect(page.getByTestId("report-scope")).toContainText("资料截止时间");
  // 说明文字里会写“不是概率”，所以只检查百分比与成功率/成功概率的断言
  expect(await report.innerText()).not.toMatch(/\d+(\.\d+)?\s*[%％]|成功率|成功概率/);

  // 证据可展开，显示被引用的消息原文与上下文
  const dim = page.getByTestId("dimension-willingness_to_know");
  await expect(dim.getByText("线索", { exact: true }).first()).toBeVisible(); // 两天各一次提问：只是线索，不计分
  await dim.getByText(/查看证据/).first().click();
  await expect(dim.getByTestId("evidence-list").first()).toContainText("最近在忙什么");

  // 额度：1 次分析
  await page.goto("/me");
  await expect(page.getByTestId("quota-analysis")).toHaveText("7");

  // 新增资料：不会自动分析，只提示“有新资料待分析”，旧报告保留
  await importTextChat(page, personId, "[2026-03-10 20:00] 阿青：你好吗？\n[2026-03-10 20:01] 我：好的", { prefilled: true });
  await openAnalysis(page, personId);
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "NEW_DATA");
  await expect(page.getByTestId("report")).toBeVisible();
  await page.goto("/");
  await expect(page.getByTestId("todo-analysis")).toContainText("有新资料待分析");

  // 修改偏好：旧分析标记“偏好变更待更新”（优先级高于“有新资料”）
  await page.goto("/me/preferences");
  await waitForHydration(page);
  await page.getByLabel("行动兑现").selectOption("5");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.getByText("偏好已保存")).toBeVisible();
  await openAnalysis(page, personId);
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "PREFERENCE_CHANGED");
  await expect(page.getByTestId("freshness")).toContainText("口径变化");

  // 重新分析后回到“最新”，且额度再扣 1 次
  await runAnalysis(page, personId, "重新分析");
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "FRESH");
  await page.goto("/me");
  await expect(page.getByTestId("quota-analysis")).toHaveText("6");
  await ctx.close();
});

test("对方明确拒绝：报告停止一切推进类建议，只提醒尊重边界", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());
  await importTextChat(page, personId, "[2026-03-05 21:00] 我：周六有空吗？想约你吃饭\n[2026-03-05 21:10] 阿青：不好意思，请不要再联系我了");

  await openAnalysis(page, personId);
  await acceptConsent(page);
  await runAnalysis(page, personId);

  await expect(page.getByTestId("refusal-notice")).toContainText("对方明确表示不希望继续联系");
  const suggestions = page.getByTestId("suggestion");
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions.first()).toContainText("尊重边界");
  await expect(page.getByText("推进", { exact: true })).toHaveCount(0);
  await ctx.close();
});
