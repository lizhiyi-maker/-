import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { buildAnalysisModel, buildSms, buildStorage, buildVision } from "@/server/providers";

const strong = "a".repeat(40);
const base = {
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
  OSS_BUCKET: "test-bucket",
  OSS_REGION: "oss-cn-hangzhou",
  SMS_SIGN_NAME: "n",
  SMS_TEMPLATE_CODE: "SMS_1",
};

describe("提供方装配（短信、存储）", () => {
  it("生产配置：短信用阿里云、存储用 OSS，装配成功（不再是“尚未实现”），且装配时不发任何请求", () => {
    const env = parseEnv(base);
    expect(typeof buildSms(env).send).toBe("function");
    const st = buildStorage(env);
    expect(typeof st.put).toBe("function");
    // 令牌签名可用（不需要网络）
    expect(st.verifyToken(st.signToken("u/a/1", 60))).toBe("u/a/1");
  });

  it("演示配置：仍然装配模拟短信与本地存储", () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: "development",
      APP_MODE: "demo",
      DEV_LOGIN_ENABLED: "true",
      SMS_PROVIDER: "mock",
      STORAGE_PROVIDER: "local",
      AI_PROVIDER: "mock",
      AUTH_SECRET: "dev-only-auth-secret",
    });
    expect(typeof buildSms(env).send).toBe("function");
    expect(typeof buildStorage(env).list).toBe("function");
  });

  it("短信模板变量名默认 code，可用 SMS_TEMPLATE_PARAM_NAME 改", () => {
    expect(parseEnv(base).SMS_TEMPLATE_PARAM_NAME).toBe("code");
    expect(parseEnv({ ...base, SMS_TEMPLATE_PARAM_NAME: "verifyCode" }).SMS_TEMPLATE_PARAM_NAME).toBe("verifyCode");
  });

  it("令牌签名密钥来自 AUTH_SECRET：换了密钥，旧令牌失效", () => {
    const a = buildStorage(parseEnv(base));
    const b = buildStorage(parseEnv({ ...base, AUTH_SECRET: "b".repeat(40) }));
    expect(b.verifyToken(a.signToken("u/a/1", 60))).toBeNull();
  });

  it("生产配置：分析与识别用百炼适配器（模型名来自环境变量），不是模拟模型，装配时不发请求", () => {
    const env = parseEnv(base);
    const analysis = buildAnalysisModel(env);
    const vision = buildVision(env);
    expect(analysis.id).toBe("bailian:text-model-x");
    expect(analysis.simulated).toBeFalsy();
    expect(vision.id).toBe("bailian:vision-model-y");
    expect(vision.simulated).toBeFalsy();
  });

  it("演示配置：分析与识别仍用模拟模型", () => {
    const env = parseEnv({ ...base, NODE_ENV: "development", APP_MODE: "demo", DEV_LOGIN_ENABLED: "true", SMS_PROVIDER: "mock", STORAGE_PROVIDER: "local", AI_PROVIDER: "mock", AUTH_SECRET: "dev-only-auth-secret" });
    expect(buildAnalysisModel(env).simulated).toBe(true);
    expect(buildVision(env).simulated).toBe(true);
  });
});
