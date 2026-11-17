import { expect, test } from "@playwright/test";
import { createInviteAsAdmin, devLogin, gotoLogin, randomPhone, smsLogin, uniqueName, waitForHydration } from "./helpers";

test("新用户：管理员发邀请码 → 手机号验证码登录 → 我的页显示脱敏手机号与默认额度", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const phone = randomPhone();
  await smsLogin(page, phone, invite);
  await page.goto("/me");
  await expect(page.getByTestId("phone-masked")).toContainText(`${phone.slice(0, 3)}****${phone.slice(-4)}`);
  await expect(page.getByTestId("quota-screenshot")).toHaveText("120");
  await expect(page.getByTestId("quota-analysis")).toHaveText("8");
  await ctx.close();
});

test("新手机号没有邀请码时无法登录，并提示需要邀请码", async ({ page }) => {
  await gotoLogin(page);
  await page.getByLabel("手机号").fill(randomPhone());
  await page.getByRole("button", { name: "获取验证码" }).click();
  const code = (await page.getByTestId("demo-code").locator("strong").textContent())!.trim();
  await page.getByLabel("验证码").fill(code);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("新用户需要邀请码")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("对象：只填昵称创建 → 记录好感 → 关联平台账号 → 编辑阶段 → 删除", async ({ page }) => {
  await devLogin(page);
  const name = uniqueName();

  await page.getByRole("link", { name: "新建对象" }).click();
  await page.getByLabel("昵称或代号").fill(name);
  await page.getByRole("button", { name: "创建对象" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  await expect(page.getByText("阶段未设置").first()).toBeVisible();

  const feeling = page.getByRole("group", { name: "我的好感" });
  await feeling.getByRole("button", { name: "想继续了解" }).click();
  await expect(feeling.getByRole("button", { name: "想继续了解" })).toHaveAttribute("aria-pressed", "true");
  await feeling.getByRole("button", { name: "很心动" }).click();
  await expect(feeling.getByRole("button", { name: "很心动" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("list", { name: "好感变化记录" }).getByRole("listitem")).toHaveCount(2);

  await page.getByLabel("账号或昵称").fill("wx_demo");
  await page.getByRole("button", { name: "确认关联到此对象" }).click();
  await expect(page.getByTestId("account-list")).toContainText("wx_demo");

  await page.getByRole("link", { name: "编辑" }).click();
  await page.getByLabel("关系阶段").selectOption("GETTING_TO_KNOW");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("正在了解").first()).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "删除对象" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(name)).toHaveCount(0);
});

test("性别筛选：未填性别的对象只在“全部”里出现", async ({ page }) => {
  await devLogin(page);
  const male = uniqueName("男");
  const none = uniqueName("未填");
  for (const [name, gender] of [[male, "MALE"], [none, ""]] as const) {
    await page.goto("/people/new");
    await page.getByLabel("昵称或代号").fill(name);
    await page.getByText("更多信息（选填）").click();
    if (gender) await page.getByLabel("性别").selectOption(gender);
    await page.getByRole("button", { name: "创建对象" }).click();
    await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  }
  await page.goto("/");
  await expect(page.getByTestId("people-list")).toContainText(male);
  await expect(page.getByTestId("people-list")).toContainText(none);
  await page.getByRole("link", { name: "男", exact: true }).click();
  await expect(page.getByTestId("people-list")).toContainText(male);
  await expect(page.getByText(none)).toHaveCount(0);
  await page.getByRole("link", { name: "女", exact: true }).click();
  await expect(page).toHaveURL(/gender=FEMALE/);
  await expect(page.getByText(male)).toHaveCount(0);
});

test("偏好：默认配置 → 调整重要程度保存 → 恢复默认", async ({ browser }) => {
  // 使用独立的新用户，避免与并行用例共享偏好版本
  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await smsLogin(page, randomPhone(), invite);

  await page.goto("/me/preferences");
  await waitForHydration(page);
  await expect(page.getByText("使用默认配置").first()).toBeVisible();
  await page.getByLabel("行动兑现").selectOption("5");
  await page.getByLabel("推进节奏").selectOption("SLOW");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.getByText("偏好已保存")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/已自定义 · 版本 1/)).toBeVisible();
  await expect(page.getByLabel("行动兑现")).toHaveValue("5");

  await page.getByRole("button", { name: "恢复默认配置" }).click();
  await expect(page.getByText(/使用默认配置/).first()).toBeVisible();
  await expect(page.getByLabel("行动兑现")).toHaveValue("3");
  await ctx.close();
});

test("用户隔离：另一用户访问我的对象得到 404；普通用户看不到后台", async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await devLogin(pa);
  const name = uniqueName("私密");
  await pa.goto("/people/new");
  await pa.getByLabel("昵称或代号").fill(name);
  await pa.getByRole("button", { name: "创建对象" }).click();
  await expect(pa.getByRole("heading", { name }).first()).toBeVisible();
  const url = pa.url();

  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();

  const b = await browser.newContext();
  const pb = await b.newPage();
  await smsLogin(pb, randomPhone(), invite);
  const resp = await pb.goto(url);
  expect(resp?.status()).toBe(404);
  await expect(pb.getByText(name)).toHaveCount(0);
  const adminResp = await pb.goto("/admin");
  expect(adminResp?.status()).toBe(404);
  await pb.goto("/");
  await expect(pb.getByText(name)).toHaveCount(0);
  await a.close();
  await b.close();
});

test("管理后台：用户列表只显示脱敏手机号，补发额度后审计可见", async ({ page }) => {
  await devLogin(page, "admin");
  await page.goto("/admin/users");
  const list = page.getByTestId("user-list");
  await expect(list).toBeVisible();
  await expect(list).not.toContainText(/1\d{10}/);
  const row = list.getByRole("listitem").filter({ hasText: "138****0000" }).first();
  await row.getByLabel("补发原因").fill("e2e 补发");
  await row.getByRole("button", { name: "补发" }).click();
  await expect(row.getByText("已补发")).toBeVisible();
  await page.goto("/admin/audit");
  await expect(page.getByTestId("audit-table")).toContainText("quota.grant");
});
