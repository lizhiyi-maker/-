import { expect, type Page } from "@playwright/test";

export const uniqueName = (prefix = "对象") => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 等待客户端组件完成水合；受控输入在水合前填写的内容会被 React 重置。 */
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("input:not([type=hidden]), select");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  });
}

export async function gotoLogin(page: Page) {
  await page.goto("/login");
  await waitForHydration(page);
}

export async function devLogin(page: Page, kind: "user" | "admin" = "user") {
  await page.goto("/login");
  await page.getByRole("button", { name: kind === "admin" ? "演示管理员登录" : "演示用户登录" }).click();
  await expect(page.getByRole("heading", { name: kind === "admin" ? "管理后台" : "对象" })).toBeVisible();
}

/** 管理员后台生成一个一次性邀请码，返回邀请码文本。 */
export async function createInviteAsAdmin(page: Page): Promise<string> {
  await devLogin(page, "admin");
  // 并行用例可能取到同一行邀请码，所以给足使用次数
  await page.getByLabel("可使用次数").fill("1000");
  await page.getByRole("button", { name: "生成邀请码" }).click();
  await expect(page.getByText("邀请码已生成")).toBeVisible();
  const first = page.getByTestId("invite-table").locator("tbody tr").first().locator("td").first();
  const code = (await first.textContent())?.trim();
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
  return code!;
}

let seq = Math.floor(Math.random() * 1_000_000);
export const randomPhone = () => `137${String(10_000_000 + ((seq += 7919) % 89_999_999))}`;

/** 通过界面完成手机号 + 验证码 + 邀请码登录（演示模式下验证码显示在页面上）。 */
export async function smsLogin(page: Page, phone: string, inviteCode: string) {
  await gotoLogin(page);
  await page.getByLabel("手机号").fill(phone);
  await page.getByRole("button", { name: "获取验证码" }).click();
  const hint = page.getByTestId("demo-code");
  await expect(hint).toBeVisible();
  const code = (await hint.locator("strong").textContent())!.trim();
  await page.getByLabel("验证码").fill(code);
  await page.getByLabel(/邀请码/).fill(inviteCode);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对象" })).toBeVisible();
}

/** 通过界面创建对象，返回对象 ID。 */
export async function createPerson(page: Page, name: string): Promise<string> {
  await page.goto("/people/new");
  await page.getByLabel("昵称或代号").fill(name);
  await page.getByRole("button", { name: "创建对象" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  return page.url().split("/people/")[1].split("?")[0];
}

/** 一个独立的新用户（邀请码 + 验证码登录），用于需要精确断言额度的用例。 */
export async function freshUser(browser: import("@playwright/test").Browser) {
  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await smsLogin(page, randomPhone(), invite);
  return { ctx, page };
}
