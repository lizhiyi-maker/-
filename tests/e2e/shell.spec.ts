import { expect, test } from "@playwright/test";
import { devLogin } from "./helpers";

test("未登录访问首页会跳转到登录页，登录页显示演示标识", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
});

test("登录后按视口展示对应导航，并可切换页面", async ({ page, isMobile }) => {
  await devLogin(page);
  await expect(page.getByTestId("demo-banner")).toBeVisible();

  const nav = page.getByRole("navigation", { name: isMobile ? "底部导航" : "主导航" });
  await expect(nav).toBeVisible();
  for (const label of ["对象", "对比", "记录", "我的"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await nav.getByRole("link", { name: "对比" }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect(page.getByRole("heading", { name: "对比" })).toBeVisible();
});

test("手机端不出现横向滚动（登录页与对象页）", async ({ page, isMobile }) => {
  test.skip(!isMobile, "仅手机视口");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.goto("/login");
  expect(await overflow()).toBe(false);
  await devLogin(page);
  expect(await overflow()).toBe(false);
});
