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

/** 在“AI 服务说明”卡片上点击同意（卡片出现时）。 */
export async function acceptConsent(page: Page) {
  const card = page.getByTestId("consent-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "我已阅读并同意" }).click();
  await expect(card).toHaveCount(0);
}

/** 通过界面粘贴并保存一批聊天文本（对象已有上次保存的“我/对方”设置时，需要再确认一次）。 */
export async function importTextChat(page: Page, personId: string, text: string, opts: { prefilled?: boolean } = {}) {
  await page.goto(`/people/${personId}/import/new`);
  await waitForHydration(page);
  await fillPastedText(page, text);
  await page.getByRole("button", { name: "整理并进入确认" }).click();
  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible();
  if (opts.prefilled) {
    await page.getByRole("button", { name: "已按上次设置预填，确认无误" }).click();
  } else {
    for (const [label, role] of [["阿青", "对方"], ["我", "我"]] as const) {
      const btn = page.getByRole("button", { name: `将“${label}”设为${role}` });
      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
    }
  }
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByTestId("saved-notice")).toBeVisible();
}

/**
 * 填写粘贴文本，并确认受控输入真的登记了（字数计数更新）。水合完成之前填入的内容会被 React 重置，
 * 在负载高的 WebKit 上会发生，所以失败就重填。
 */
export async function fillPastedText(page: Page, text: string) {
  await expect(async () => {
    await page.getByLabel("粘贴聊天文本").fill(text);
    // 计数从“0 / 20000 字”变成实际字数，说明受控输入已登记（注意不能用子串匹配：“120 /” 也含 “0 /”）
    await expect(page.getByTestId("char-count")).not.toHaveText(/^\s*0 \//, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}
