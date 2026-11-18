import { expect, test, type Page } from "@playwright/test";
import { acceptConsent, createPerson, freshUser, importTextChat, uniqueName, waitForHydration } from "./helpers";

const CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班\n[2026-03-02 20:00] 阿青：周末有什么打算吗？\n[2026-03-02 20:03] 我：还没想好";
const FACTS = "周六下午在咖啡店见面，聊了两个小时，她先结的账。";
const NOTE = "回来的路上心跳很快，有点紧张";

const records = (page: Page, personId: string) => page.goto(`/people/${personId}?tab=records`);

/** 点击开始/重新分析并等待新报告成为“最新”（报告由独立 worker 生成，进行中的页面会自动刷新）。 */
async function runAnalysis(page: Page, personId: string, buttonName = "开始分析") {
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(page.getByTestId("freshness")).toHaveAttribute("data-freshness", "FRESH", { timeout: 45_000 });
  await page.goto(`/people/${personId}?tab=analysis`);
}

async function freshness(page: Page, personId: string) {
  await page.goto(`/people/${personId}?tab=analysis`);
  return page.getByTestId("freshness");
}

test("线下事件：事实与感受分开 → 分析引用事件（不含感受）→ 只改感受不影响报告、改事实使报告过期 → 时间线复盘", async ({ browser }) => {
  test.setTimeout(300_000);
  const { ctx, page } = await freshUser(browser);
  const personId = await createPerson(page, uniqueName());
  await importTextChat(page, personId, CHAT);
  await page.goto(`/people/${personId}?tab=analysis`);
  await acceptConsent(page);
  await runAnalysis(page, personId);

  // 记录一个线下事件：事实与感受是两个独立的输入
  await records(page, personId);
  await expect(page.getByText("补充一个线下事件")).toBeVisible();
  await waitForHydration(page);
  await page.getByLabel("发生日期").fill("2026-03-05");
  await page.getByLabel("发生了什么").fill(FACTS);
  await page.getByLabel("我的感受").fill(NOTE);
  await page.getByRole("button", { name: "记录事件" }).click();
  const event = page.getByTestId("timeline-event");
  await expect(event).toHaveCount(1);
  await expect(event.getByTestId("event-facts")).toHaveText(FACTS);
  await expect(event.getByTestId("event-note")).toContainText(NOTE);
  await expect(event.getByTestId("event-facts")).not.toContainText("心跳"); // 感受不混进事实
  await expect(event.getByTestId("event-note")).toContainText("不发送给 AI 服务商");

  // 新增事件 → “有新资料待分析”，旧报告仍在
  expect(await (await freshness(page, personId)).getAttribute("data-freshness")).toBe("NEW_DATA");
  await expect(page.getByTestId("report")).toBeVisible();

  // 重新分析：报告引用事件，证据只显示事实，不含个人感受
  await runAnalysis(page, personId, "重新分析");
  await expect(page.getByTestId("report-event-scope")).toContainText("线下事件 1 个");
  const dim = page.getByTestId("dimension-follow_through");
  await dim.getByText(/查看证据/).first().click();
  await expect(dim.getByTestId("evidence-event").first()).toContainText(FACTS);
  expect(await page.getByTestId("report").innerText()).not.toContain("心跳");

  // 只修改个人感受：报告仍是“最新”
  await records(page, personId);
  await page.getByTestId("timeline-event").getByRole("link", { name: "编辑" }).click();
  await waitForHydration(page);
  await page.getByTestId("timeline-event-editing").getByLabel("我的感受").fill("现在回想，其实没那么紧张");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByTestId("event-note")).toContainText("没那么紧张");
  await expect(page.getByTestId("timeline-event")).not.toContainText("事实已修改");
  await expect(await freshness(page, personId)).toHaveAttribute("data-freshness", "FRESH");

  // 修改事实：报告变为“资料纠正已过期”，展开的证据仍是分析当时的内容并说明被修改过
  await records(page, personId);
  await page.getByTestId("timeline-event").getByRole("link", { name: "编辑" }).click();
  await waitForHydration(page);
  await page.getByTestId("timeline-event-editing").getByLabel("发生了什么").fill("（纠正）周六下午在餐厅见面，她先结的账。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByTestId("timeline-event")).toContainText("事实已修改 1 次");
  await expect(await freshness(page, personId)).toHaveAttribute("data-freshness", "CORRECTED_EXPIRED");
  await page.getByTestId("dimension-follow_through").getByText(/查看证据/).first().click();
  const evidence = page.getByTestId("dimension-follow_through").getByTestId("evidence-event").first();
  await expect(evidence).toContainText(FACTS);
  await expect(evidence).toContainText("被你修改过");

  // 好感变化进入时间线（不参与评分）
  await page.goto(`/people/${personId}`);
  await page.getByRole("button", { name: "很心动" }).click();
  await expect(page.getByRole("button", { name: "很心动" })).toHaveAttribute("aria-pressed", "true");

  // 改偏好后重新分析：时间线上的第三份快照标注“口径变化”
  await page.goto("/me/preferences");
  await waitForHydration(page);
  await page.getByLabel("行动兑现").selectOption("5");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.getByText("偏好已保存")).toBeVisible();
  await page.goto(`/people/${personId}?tab=analysis`);
  await runAnalysis(page, personId, "重新分析");

  await records(page, personId);
  await expect(page.getByTestId("timeline-analysis")).toHaveCount(3);
  await expect(page.getByTestId("baseline-changed")).toHaveCount(1);
  await expect(page.getByTestId("timeline-feeling")).toContainText("很心动");
  await expect(page.getByTestId("timeline-feeling")).toContainText("不参与系统评分");
  // 最新在前：分析快照排在事件之前
  const order = await page.getByTestId("timeline").locator("[data-testid^=timeline-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(order[0]).toBe("timeline-analysis");
  expect(order.at(-1)).toBe("timeline-event");

  // 删除事件（确认框）：时间线里消失，引用它的最新报告变为“资料纠正已过期”
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("timeline-event").getByRole("button", { name: "删除" }).click();
  await expect(page.getByTestId("timeline-event")).toHaveCount(0);
  await expect(await freshness(page, personId)).toHaveAttribute("data-freshness", "CORRECTED_EXPIRED");
  await ctx.close();
});

test("线下事件表单：事实必填，日期不能晚于今天；记录入口页列出对象", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const name = uniqueName();
  const personId = await createPerson(page, name);

  await records(page, personId);
  await expect(page.getByText("还没有记录")).toBeVisible();
  await waitForHydration(page);
  await page.getByLabel("发生日期").fill("2026-03-05");
  await page.getByRole("button", { name: "记录事件" }).click(); // 事实为空：浏览器校验拦截，不会提交
  await expect(page.getByTestId("timeline-event")).toHaveCount(0);
  const max = await page.getByLabel("发生日期").getAttribute("max");
  expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await page.goto("/records");
  await expect(page.getByTestId("records-people")).toContainText(name);
  await page.getByRole("link", { name: "查看时间线" }).first().click();
  await expect(page.getByText("补充一个线下事件")).toBeVisible();
  await ctx.close();
});
