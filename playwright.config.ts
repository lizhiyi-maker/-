import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: "zh-CN" },
  projects: [
    { name: "iphone-safari", use: { ...devices["iPhone 14"] } },
    { name: "android-chrome", use: { ...devices["Pixel 7"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_MODE: "demo",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54329/relationship",
      AUTH_SECRET: "dev-only-auth-secret-change-me-0000000000",
      PHONE_HMAC_KEY: "dev-only-phone-hmac-key-change-me-00000",
      PHONE_ENC_KEY: "dev-only-phone-enc-key-change-me-0000000",
      DEV_LOGIN_ENABLED: "true",
    },
  },
});
