import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3100;
const DB_PORT = 54331;

// Web 与 worker 必须共用同一个本地存储目录；固定路径，由 globalSetup 在每次运行前清空。
// 放在仓库之外：开发服务器会监视项目目录，运行期间在项目内写文件会触发整页重载，导致用例随机超时。
const uploadDir = join(tmpdir(), "rel-e2e-uploads");

const sharedEnv = {
  APP_MODE: "demo",
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/e2e`,
  AUTH_SECRET: "dev-only-auth-secret-change-me-0000000000",
  PHONE_HMAC_KEY: "dev-only-phone-hmac-key-change-me-00000",
  PHONE_ENC_KEY: "dev-only-phone-enc-key-change-me-0000000",
  DEV_LOGIN_ENABLED: "true",
  SMS_PROVIDER: "mock",
  AI_PROVIDER: "mock",
  STORAGE_PROVIDER: "local",
  STORAGE_LOCAL_DIR: uploadDir,
  TRUSTED_PROXY_HOPS: "1",
};

export default defineConfig({
  testDir: "tests/e2e",
  // 同理，测试产物也不写进项目目录
  outputDir: join(tmpdir(), "rel-e2e-results"),
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  workers: 3,
  reporter: [["list"]],
  // 开发服务器首次编译某个路由可能超过默认的 5 秒
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: "zh-CN" },
  projects: [
    // 预热：先串行编译所有路由，避免并行冷启动导致偶发超时
    { name: "warmup", testMatch: /warmup\.setup\.ts/, use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.9" } } },
    // 每个项目用不同的 X-Forwarded-For，避免并行项目共用同一个 IP 限流桶
    { name: "iphone-safari", dependencies: ["warmup"], use: { ...devices["iPhone 14"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.1" } } },
    { name: "android-chrome", dependencies: ["warmup"], use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.2" } } },
    { name: "desktop-chrome", dependencies: ["warmup"], use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.3" } } },
  ],
  webServer: [
    {
      // 第一个启动：临时数据库（Playwright 按顺序启动 webServer，globalSetup 晚于它们，所以数据库不能放在 globalSetup 里）
      command: "npx tsx scripts/e2e-db.ts",
      reuseExistingServer: false,
      timeout: 120_000,
      wait: { stdout: /E2E DB READY/ },
      env: { E2E_DB_PORT: String(DB_PORT) },
    },
    {
      command: `npx next dev --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/api/health`,
      // PW_DEBUG=1 时输出服务端日志，便于排查
      stdout: process.env.PW_DEBUG ? "pipe" : "ignore",
      reuseExistingServer: false,
      timeout: 120_000,
      env: sharedEnv,
    },
    {
      // 独立的后台 worker（pg-boss）：识别任务由它执行，与 Web 进程分离
      command: "npx tsx src/worker/index.ts",
      reuseExistingServer: false,
      timeout: 120_000,
      wait: { stdout: /worker 已启动/ },
      env: sharedEnv,
    },
  ],
});
