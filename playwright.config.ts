import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const DB_PORT = 54331;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  workers: 3,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: "zh-CN" },
  projects: [
    // 预热：先串行编译所有路由，避免并行冷启动导致偶发超时
    { name: "warmup", testMatch: /warmup\.setup\.ts/, use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.9" } } },
    // 每个项目用不同的 X-Forwarded-For，避免并行项目共用同一个 IP 限流桶
    { name: "iphone-safari", dependencies: ["warmup"], use: { ...devices["iPhone 14"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.1" } } },
    { name: "android-chrome", dependencies: ["warmup"], use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.2" } } },
    { name: "desktop-chrome", dependencies: ["warmup"], use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.3" } } },
  ],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_MODE: "demo",
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/e2e`,
      AUTH_SECRET: "dev-only-auth-secret-change-me-0000000000",
      PHONE_HMAC_KEY: "dev-only-phone-hmac-key-change-me-00000",
      PHONE_ENC_KEY: "dev-only-phone-enc-key-change-me-0000000",
      DEV_LOGIN_ENABLED: "true",
      SMS_PROVIDER: "mock",
      TRUSTED_PROXY_HOPS: "1",
    },
  },
});
