import { expect, test, request as pwRequest } from "@playwright/test";
import { createInviteAsAdmin, createPerson, freshUser, importTextChat, randomPhone, smsLogin, uniqueName, waitForHydration } from "./helpers";

const CHAT = "[2026-03-01 20:00] 阿青：最近在忙什么？\n[2026-03-01 20:02] 我：加班\n[2026-03-02 20:00] 阿青：周末有什么打算吗？";

test("数据导出：我的页有下载入口；JSON 只含本人数据且不含手机号；对象的聊天文本可下载；未登录与他人的对象被拒绝", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await freshUser(browser);
  const name = uniqueName("导出");
  const personId = await createPerson(page, name);
  await importTextChat(page, personId, CHAT);

  await page.goto("/me");
  await expect(page.getByTestId("export-link")).toBeVisible();
  const phoneMasked = (await page.getByTestId("phone-masked").innerText()).replace("手机号：", "").trim();

  const res = await page.request.get("/api/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename="relationship-export-\d{4}-\d{2}-\d{2}\.json"/);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const raw = await res.text();
  const bundle = JSON.parse(raw);
  expect(bundle).toMatchObject({ format: "relationship-export", version: 1 });
  expect(bundle.people).toHaveLength(1);
  expect(bundle.people[0]).toMatchObject({ nickname: name });
  expect(raw).toContain("最近在忙什么");
  expect(raw).not.toMatch(/\b1[3-9]\d{9}\b/); // 没有完整手机号
  expect(phoneMasked).toContain("****");

  // 单个对象的聊天文本
  await page.goto(`/people/${personId}?tab=chats`);
  await expect(page.getByTestId("export-chat-link")).toBeVisible();
  const chat = await page.request.get(`/api/export/people/${personId}/chat`);
  expect(chat.status()).toBe(200);
  expect(chat.headers()["content-type"]).toContain("text/plain");
  expect(chat.headers()["content-disposition"]).toContain("attachment");
  const text = await chat.text();
  expect(text).toContain("[2026-03-01 20:00] 对方：最近在忙什么？");
  expect(text).toContain("[2026-03-01 20:02] 我：加班");

  // 未登录：401；另一个用户访问我的对象：404
  const anon = await pwRequest.newContext({ baseURL });
  expect((await anon.get("/api/export")).status()).toBe(401);
  expect((await anon.get(`/api/export/people/${personId}/chat`)).status()).toBe(401);
  await anon.dispose();
  const other = await freshUser(browser);
  expect((await other.page.request.get(`/api/export/people/${personId}/chat`)).status()).toBe(404);
  const otherBundle = await (await other.page.request.get("/api/export")).text();
  expect(otherBundle).not.toContain(name);
  await other.ctx.close();
  await ctx.close();
});

test("删除账户：必须输入确认文字；删除后立即退出、不能再访问或导出", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminCtx = await browser.newContext();
  const invite = await createInviteAsAdmin(await adminCtx.newPage());
  await adminCtx.close();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const phone = randomPhone();
  await smsLogin(page, phone, invite);
  const personId = await createPerson(page, uniqueName("删除"));
  await importTextChat(page, personId, CHAT);

  await page.goto("/me");
  await waitForHydration(page);
  await expect(page.getByTestId("delete-account-card")).toContainText("无法恢复");
  await expect(page.getByTestId("delete-account-card")).toContainText("尚未核实"); // 如实说明备份与服务商留存未核实

  // 没有输入正确的确认文字：不删除
  await page.getByLabel(/请输入/).fill("随便写点什么");
  await page.getByRole("button", { name: "永久删除我的账户" }).click();
  await expect(page.getByTestId("delete-account-form").getByRole("alert")).toContainText("删除我的账户");
  await page.goto(`/people/${personId}`);
  await expect(page.getByRole("heading").first()).toBeVisible();

  // 输入确认文字：立即退出登录
  await page.goto("/me");
  await waitForHydration(page);
  await page.getByLabel(/请输入/).fill("删除我的账户");
  await page.getByRole("button", { name: "永久删除我的账户" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get("/api/export")).status()).toBe(401);

  await ctx.close();
});
