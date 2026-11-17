import { expect, test, type Page } from "@playwright/test";
import { createInviteAsAdmin, devLogin, fillPastedText, randomPhone, smsLogin, uniqueName, waitForHydration } from "./helpers";

const CHAT = ["阿青：今晚吃什么", "我：火锅怎么样", "???", "阿青：好呀", "我：七点见", "阿青：不见不散"].join("\n");

async function createPerson(page: Page, name: string) {
  await page.goto("/people/new");
  await page.getByLabel("昵称或代号").fill(name);
  await page.getByRole("button", { name: "创建对象" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  return page.url().split("/people/")[1];
}

async function pasteAndSubmit(page: Page, personId: string, text: string, kindLabel?: string) {
  await page.goto(`/people/${personId}/import/new`);
  await waitForHydration(page);
  if (kindLabel) await page.getByRole("radio", { name: new RegExp(`^${kindLabel}`) }).check();
  await fillPastedText(page, text);
  await page.getByRole("button", { name: "整理并进入确认" }).click();
  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible();
}

async function setRole(page: Page, label: string, role: "我" | "对方") {
  const btn = page.getByRole("button", { name: `将“${label}”设为${role}` });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

test("粘贴 → 确认身份 → 处理不确定内容 → 保存 → 在聊天资料页看到；未知时间不被猜测", async ({ page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());

  await pasteAndSubmit(page, personId, CHAT);
  const save = page.getByRole("button", { name: "确认保存" });
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("blockers")).toContainText("我");
  await expect(page.getByTestId("uncertain-section")).toContainText("???");

  await setRole(page, "阿青", "对方");
  await setRole(page, "我", "我");
  await expect(save).toBeDisabled(); // 还有不确定的内容
  await page.getByTestId("uncertain-section").getByRole("button", { name: "丢弃", exact: true }).click();
  await expect(page.getByTestId("uncertain-section")).toHaveCount(0);
  await expect(save).toBeEnabled();

  await save.click();
  await expect(page).toHaveURL(/tab=chats&saved=5/);
  await expect(page.getByTestId("saved-notice")).toContainText("已保存 5 条消息");
  await expect(page.getByRole("link", { name: "继续添加资料" })).toBeVisible();
  // 保存后只提供入口，不会自动分析：由用户点击进入“分析与建议”再决定
  await expect(page.getByRole("link", { name: "开始分析" })).toHaveAttribute("href", /tab=analysis/);

  await page.getByRole("link", { name: "查看" }).click();
  const list = page.getByTestId("message-list");
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(list).toContainText("时间未知");
  await expect(list).toContainText("七点见");
});

test("交换“我/对方”：显示受影响的消息数", async ({ page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());
  await pasteAndSubmit(page, personId, "阿青：在吗\n我：在");
  await expect(page.getByRole("button", { name: "交换“我/对方”" })).toBeDisabled();
  await setRole(page, "阿青", "对方");
  await setRole(page, "我", "我");
  await page.getByRole("button", { name: "交换“我/对方”" }).click();
  await expect(page.getByTestId("swap-notice")).toContainText("已交换 2 条消息");
  await expect(page.getByRole("button", { name: "将“阿青”设为我" })).toHaveAttribute("aria-pressed", "true");
});

test("编辑一条消息的文字后保存，并保留“已修改”标记", async ({ page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());
  await pasteAndSubmit(page, personId, "阿青：在吗\n我：在");
  await setRole(page, "阿青", "对方");
  await setRole(page, "我", "我");
  const first = page.getByTestId("preview-list").getByRole("listitem").first();
  await first.getByText("编辑", { exact: true }).click();
  await first.getByLabel("消息内容").fill("在吗？周六有空吗");
  await first.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByTestId("preview-list")).toContainText("在吗？周六有空吗");
  await expect(page.getByTestId("preview-list")).toContainText("已修改");
});

test("第二批与已保存聊天重叠：提示重复、按上次设置预填身份、默认合并", async ({ page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());
  await pasteAndSubmit(page, personId, "阿青：今晚吃什么\n我：火锅怎么样\n阿青：好呀\n我：七点见\n阿青：不见不散");
  await setRole(page, "阿青", "对方");
  await setRole(page, "我", "我");
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByTestId("saved-notice")).toBeVisible();

  await pasteAndSubmit(page, personId, "我：七点见\n阿青：不见不散\n我：我到了", "精选片段");
  await expect(page.getByTestId("blockers")).toContainText("确认");
  await page.getByRole("button", { name: "已按上次设置预填，确认无误" }).click();
  await expect(page.getByText("有 2 条消息与已保存的聊天重复")).toBeVisible();
  await expect(page.getByTestId("preview-list")).toContainText("与已保存的聊天重复");
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByTestId("saved-notice")).toContainText("已保存 1 条消息，合并了 2 条重复消息");
  await expect(page.getByText("精选片段").first()).toBeVisible();
});

test("未保存的批次出现在首页待办，可继续确认；放弃后消失", async ({ page }) => {
  await devLogin(page);
  const name = uniqueName();
  const personId = await createPerson(page, name);
  await pasteAndSubmit(page, personId, "阿青：在吗\n我：在");

  await page.goto("/");
  const todo = page.getByTestId("todo-pending");
  await expect(todo).toContainText(name);
  await todo.getByRole("listitem").filter({ hasText: name }).getByRole("link", { name: "去确认" }).click();
  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "放弃这批资料" }).click();
  await expect(page).toHaveURL(/tab=chats/);
  await expect(page.getByTestId("pending-batches")).toHaveCount(0);
});

test("删除已保存的批次", async ({ page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());
  await pasteAndSubmit(page, personId, "阿青：在吗\n我：在");
  await setRole(page, "阿青", "对方");
  await setRole(page, "我", "我");
  await page.getByRole("button", { name: "确认保存" }).click();
  await page.getByRole("link", { name: "查看" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "删除这批资料" }).click();
  await expect(page.getByText("还没有聊天资料")).toBeVisible();
});

test("超过字数上限时不能提交；另一用户无法打开我的确认页", async ({ browser, page }) => {
  await devLogin(page);
  const personId = await createPerson(page, uniqueName());
  await page.goto(`/people/${personId}/import/new`);
  await waitForHydration(page);
  await page.getByLabel("粘贴聊天文本").fill(`阿青：${"字".repeat(20_001)}`);
  await expect(page.getByTestId("char-count")).toContainText("20004 / 20000");
  await expect(page.getByRole("button", { name: "整理并进入确认" })).toBeDisabled();

  await pasteAndSubmit(page, personId, "阿青：在吗\n我：在");
  const url = page.url();

  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await smsLogin(other, randomPhone(), invite);
  expect((await other.goto(url))?.status()).toBe(404);
  expect((await other.goto(`/people/${personId}/import/new`))?.status()).toBe(404);
  await ctx.close();
});
