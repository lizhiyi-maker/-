import { describe, expect, it } from "vitest";
import { devLoginAllowed, EnvError, isDemoMode, parseEnv } from "@/lib/env";

const strong = "a".repeat(40);
const demoEnv = {
  NODE_ENV: "development",
  APP_MODE: "demo",
  DATABASE_URL: "postgresql://x",
  DEV_LOGIN_ENABLED: "true",
  AUTH_SECRET: "dev-only-auth-secret",
  PHONE_HMAC_KEY: "dev-only-hmac",
  PHONE_ENC_KEY: "dev-only-enc",
};
const prodEnv = {
  NODE_ENV: "production",
  APP_MODE: "production",
  DATABASE_URL: "postgresql://x",
  AI_PROVIDER: "bailian",
  STORAGE_PROVIDER: "oss",
  SMS_PROVIDER: "aliyun",
  AUTH_SECRET: strong,
  PHONE_HMAC_KEY: strong + "1",
  PHONE_ENC_KEY: strong + "2",
  DASHSCOPE_API_KEY: "k",
  DASHSCOPE_TEXT_MODEL: "text-model-x",
  DASHSCOPE_VISION_MODEL: "vision-model-y",
  ALIYUN_ACCESS_KEY_ID: "i",
  ALIYUN_ACCESS_KEY_SECRET: "s",
  OSS_BUCKET: "b",
  OSS_REGION: "oss-cn-hangzhou",
  SMS_SIGN_NAME: "n",
  SMS_TEMPLATE_CODE: "t",
};

describe("环境校验与演示开关守卫", () => {
  it("demo 配置在开发环境可启动，并显示演示状态", () => {
    expect(parseEnv(demoEnv).DEV_LOGIN_ENABLED).toBe(true);
    expect(isDemoMode(demoEnv)).toBe(true);
  });

  it("NODE_ENV=production 且 APP_MODE=demo 时拒绝启动", () => {
    expect(() => parseEnv({ ...demoEnv, NODE_ENV: "production" })).toThrow(EnvError);
  });

  it("生产环境下 isDemoMode 恒为 false", () => {
    expect(isDemoMode({ ...demoEnv, NODE_ENV: "production" })).toBe(false);
  });

  it("完整的生产配置通过", () => {
    expect(parseEnv(prodEnv).APP_MODE).toBe("production");
  });

  it.each([
    ["AI_PROVIDER", "mock"],
    ["STORAGE_PROVIDER", "local"],
    ["SMS_PROVIDER", "mock"],
    ["DEV_LOGIN_ENABLED", "true"],
  ])("生产模式拒绝 %s=%s", (key, value) => {
    expect(() => parseEnv({ ...prodEnv, [key]: value })).toThrow(EnvError);
  });

  it("生产模式拒绝过短或示例密钥", () => {
    expect(() => parseEnv({ ...prodEnv, AUTH_SECRET: "short" })).toThrow(EnvError);
    expect(() => parseEnv({ ...prodEnv, PHONE_ENC_KEY: "change-me-".repeat(5) })).toThrow(EnvError);
  });

  it("未声明 APP_MODE 时默认按生产处理（不会静默启用模拟）", () => {
    const rest: Record<string, string> = { ...demoEnv };
    delete rest.APP_MODE;
    expect(() => parseEnv(rest)).toThrow(EnvError);
  });

  it("真实提供方缺少凭据时报错，且错误消息不包含取值", () => {
    const bad = { ...prodEnv, DASHSCOPE_API_KEY: undefined, AUTH_SECRET: "super-secret-value-short" };
    try {
      parseEnv(bad);
      throw new Error("应当抛出");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as Error).message).not.toContain("super-secret-value-short");
      expect((e as Error).message).toContain("DASHSCOPE_API_KEY");
    }
  });

  it("开发登录只在演示模式、非生产且显式开启时可用", () => {
    expect(devLoginAllowed(parseEnv(demoEnv))).toBe(true);
    expect(devLoginAllowed(parseEnv({ ...demoEnv, DEV_LOGIN_ENABLED: "false" }))).toBe(false);
    expect(devLoginAllowed(parseEnv(prodEnv))).toBe(false);
    expect(devLoginAllowed({ APP_MODE: "demo", NODE_ENV: "production", DEV_LOGIN_ENABLED: true })).toBe(false);
  });

  it("AI_PROVIDER=bailian 必须显式给出文本与视觉模型名（代码里没有默认值）", () => {
    for (const key of ["DASHSCOPE_TEXT_MODEL", "DASHSCOPE_VISION_MODEL"]) {
      const bad = { ...prodEnv, [key]: undefined };
      expect(() => parseEnv(bad)).toThrow(key);
      expect(() => parseEnv({ ...prodEnv, [key]: "" })).toThrow(EnvError);
    }
  });

  it("模型名只在 bailian 时才要求；模拟模型不需要", () => {
    expect(parseEnv(demoEnv).AI_PROVIDER).toBe("mock");
  });

  it("DASHSCOPE_BASE_URL 可选；生产模式必须是 https（密钥会随请求发送，不能明文传输）", () => {
    expect(parseEnv(prodEnv).DASHSCOPE_BASE_URL).toBeUndefined();
    expect(parseEnv({ ...prodEnv, DASHSCOPE_BASE_URL: "https://dashscope.example.com/compatible-mode/v1" }).DASHSCOPE_BASE_URL).toContain("https://");
    expect(() => parseEnv({ ...prodEnv, DASHSCOPE_BASE_URL: "http://dashscope.example.com/v1" })).toThrow("DASHSCOPE_BASE_URL");
    // 演示/本地联调可以指向本机假服务
    expect(parseEnv({ ...demoEnv, AI_PROVIDER: "bailian", DASHSCOPE_API_KEY: "k", DASHSCOPE_TEXT_MODEL: "t", DASHSCOPE_VISION_MODEL: "v", DASHSCOPE_BASE_URL: "http://127.0.0.1:9999/v1" }).DASHSCOPE_BASE_URL).toBe("http://127.0.0.1:9999/v1");
  });
});
