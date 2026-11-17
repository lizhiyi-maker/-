export async function register() {
  // 构建阶段不校验；服务启动时校验，不合法则拒绝启动（含生产环境启用演示开关）。
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { getEnv } = await import("@/lib/env");
    getEnv();
  }
}
