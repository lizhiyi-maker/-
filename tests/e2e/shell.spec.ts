import { expect, test } from "@playwright/test";

test("显示演示标识，并按视口展示对应导航", async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByRole("heading", { name: "对象" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: isMobile ? "底部导航" : "主导航" });
  await expect(nav).toBeVisible();
  for (const label of ["对象", "对比", "记录", "我的"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await nav.getByRole("link", { name: "对比" }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect(page.getByRole("heading", { name: "对比" })).toBeVisible();
});

test("手机端不出现横向滚动", async ({ page, isMobile }) => {
  test.skip(!isMobile, "仅手机视口");
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
