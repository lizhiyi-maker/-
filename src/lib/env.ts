import { z } from "zod";

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const secret = z.string().min(1);

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 默认 production：未显式声明 demo 时，不会静默启用任何模拟或绕过能力。
  APP_MODE: z.enum(["demo", "production"]).default("production"),
  DATABASE_URL: z.string().min(1),
  AI_PROVIDER: z.enum(["mock", "bailian"]).default("mock"),
  STORAGE_PROVIDER: z.enum(["local", "oss"]).default("local"),
  SMS_PROVIDER: z.enum(["mock", "aliyun"]).default("mock"),
  DEV_LOGIN_ENABLED: flag,
  // 本地模拟存储（STORAGE_PROVIDER=local）的目录；默认 .data/uploads
  STORAGE_LOCAL_DIR: z.string().min(1).default(".data/uploads"),
  // 可信反向代理层数；0 表示不信任 X-Forwarded-For（IP 限流退化为单一共享桶）
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  AUTH_SECRET: secret,
  PHONE_HMAC_KEY: secret,
  PHONE_ENC_KEY: secret,
  DASHSCOPE_API_KEY: z.string().optional(),
  // 百炼的文本（分析）与视觉（截图识别）模型名：AI_PROVIDER=bailian 时必填，代码里不设默认值（以你在控制台核实过的为准）
  DASHSCOPE_TEXT_MODEL: z.string().optional(),
  DASHSCOPE_VISION_MODEL: z.string().optional(),
  // 可选：覆盖 OpenAI 兼容接口地址（默认见 src/server/ai/bailian.ts）。生产模式必须是 https
  DASHSCOPE_BASE_URL: z.string().optional(),
  ALIYUN_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_ACCESS_KEY_SECRET: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_REGION: z.string().optional(),
  SMS_SIGN_NAME: z.string().optional(),
  SMS_TEMPLATE_CODE: z.string().optional(),
  // 审核通过的短信模板里验证码变量的名字（模板是 ${code} 就填 code）
  SMS_TEMPLATE_PARAM_NAME: z.string().min(1).default("code"),
});

/** 代码认识的全部环境变量名（供配置漂移守卫测试对照 .env.example 与部署文档）。 */
export const ENV_KEYS = Object.keys(baseSchema.shape);

const PLACEHOLDER =/dev-only|change-me|example|placeholder/i;

export const envSchema = baseSchema.superRefine((env, ctx) => {
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });

  if (env.NODE_ENV === "production" && env.APP_MODE === "demo") {
    fail("APP_MODE", "生产环境（NODE_ENV=production）不允许 APP_MODE=demo");
  }

  if (env.APP_MODE === "production") {
    if (env.AI_PROVIDER === "mock") fail("AI_PROVIDER", "生产模式不得使用模拟模型");
    if (env.STORAGE_PROVIDER === "local") fail("STORAGE_PROVIDER", "生产模式不得使用本地模拟存储");
    if (env.SMS_PROVIDER === "mock") fail("SMS_PROVIDER", "生产模式不得使用模拟短信");
    if (env.DEV_LOGIN_ENABLED) fail("DEV_LOGIN_ENABLED", "生产模式不得启用开发登录");
    for (const key of ["AUTH_SECRET", "PHONE_HMAC_KEY", "PHONE_ENC_KEY"] as const) {
      if (env[key].length < 32 || PLACEHOLDER.test(env[key])) {
        fail(key, "生产模式密钥必须至少 32 字符且不得为示例值");
      }
    }
  }

  if (env.DEV_LOGIN_ENABLED && env.APP_MODE !== "demo") {
    fail("DEV_LOGIN_ENABLED", "开发登录仅允许在 APP_MODE=demo 下启用");
  }

  const need = (cond: boolean, keys: (keyof typeof env)[], why: string) => {
    if (!cond) return;
    for (const k of keys) if (!env[k]) fail(k, `${why} 需要设置 ${k}`);
  };
  need(env.AI_PROVIDER === "bailian", ["DASHSCOPE_API_KEY", "DASHSCOPE_TEXT_MODEL", "DASHSCOPE_VISION_MODEL"], "AI_PROVIDER=bailian");
  if (env.DASHSCOPE_BASE_URL !== undefined && env.APP_MODE === "production" && !/^https:\/\//i.test(env.DASHSCOPE_BASE_URL)) {
    fail("DASHSCOPE_BASE_URL", "生产模式下必须是 https 地址（API 密钥会随请求发送）");
  }
  need(env.STORAGE_PROVIDER === "oss", ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION"], "STORAGE_PROVIDER=oss");
  need(env.SMS_PROVIDER === "aliyun", ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "SMS_SIGN_NAME", "SMS_TEMPLATE_CODE"], "SMS_PROVIDER=aliyun");
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`环境配置无效：\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvError";
  }
}

/** 纯函数：解析并校验环境变量；不合法则抛出 EnvError（消息不含取值，避免泄露密钥）。 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return result.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

/** 演示状态：仅依据 APP_MODE，供界面标识使用（完整校验在启动时执行）。 */
export function isDemoMode(source: Record<string, string | undefined> = process.env): boolean {
  return source.APP_MODE === "demo" && source.NODE_ENV !== "production";
}

/** 开发登录是否可用：仅演示模式、非生产环境且显式开启。生产环境恒为 false。 */
export function devLoginAllowed(env: Pick<Env, "APP_MODE" | "NODE_ENV" | "DEV_LOGIN_ENABLED">): boolean {
  return env.APP_MODE === "demo" && env.NODE_ENV !== "production" && env.DEV_LOGIN_ENABLED;
}
