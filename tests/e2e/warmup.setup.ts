import { expect, test } from "@playwright/test";
import { devLogin, uniqueName, waitForHydration } from "./helpers";

/**
 * 预热：开发服务器首次访问每个路由时才编译，三个项目并行冷启动会互相拖慢、偶发超时。
 * 先串行访问一遍所有页面，之后的用例都在已编译的路由上运行。本身也是一次完整的冒烟检查。
 */
test("预热并冒烟：依次访问各页面", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/login");

  await devLogin(page);
  for (const path of ["/", "/me", "/me/preferences", "/compare", "/records", "/people/new"]) {
    await page.goto(path);
    await expect(page.locator("main, h1").first()).toBeVisible();
  }

  const name = uniqueName("预热");
  await page.getByLabel("昵称或代号").fill(name);
  await page.getByRole("button", { name: "创建对象" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  const personUrl = page.url();
  expect(personUrl).not.toMatch(/\/people\/new/);
  for (const suffix of ["", "?tab=chats", "/edit", "/import/new"]) {
    await page.goto(`${personUrl.split("?")[0]}${suffix}`);
    await expect(page.locator("main")).toBeVisible();
  }

  await waitForHydration(page);
  await page.getByLabel("粘贴聊天文本").fill("阿青：你好\n我：在");
  await page.getByRole("button", { name: "整理并进入确认" }).click();
  await expect(page.getByRole("heading", { name: "确认导入的聊天" })).toBeVisible();

  await page.context().clearCookies();
  await devLogin(page, "admin");
  for (const path of ["/admin", "/admin/users", "/admin/audit"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
});
