import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import type { Env } from "@/lib/env";
import { createAliyunSms, createAliyunSmsApi } from "@/server/sms/aliyun";
import { mockSms } from "@/server/sms/mock";
import type { SmsSender } from "@/server/sms/types";
import { createLocalStorage } from "@/server/storage/local";
import { createAliyunOssClient, createOssStorage } from "@/server/storage/oss";
import type { FileStorage } from "@/server/storage/types";

// 外部服务提供方的装配。环境校验（src/lib/env.ts）已保证所选提供方需要的变量都存在。
// 真实服务的接入状态见 docs/verification-matrix.md：短信与 OSS 适配器已写、用假服务测试，真实联调 ⏳。

export function buildSms(env: Env): SmsSender {
  if (env.SMS_PROVIDER === "mock") return mockSms;
  return createAliyunSms({
    api: createAliyunSmsApi({ accessKeyId: env.ALIYUN_ACCESS_KEY_ID!, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET! }),
    signName: env.SMS_SIGN_NAME!,
    templateCode: env.SMS_TEMPLATE_CODE!,
    paramName: env.SMS_TEMPLATE_PARAM_NAME,
  });
}

export function buildStorage(env: Env): FileStorage {
  // 令牌签名密钥由 AUTH_SECRET 派生，不直接复用
  const secret = createHmac("sha256", env.AUTH_SECRET).update("file-url-signing").digest("hex");
  if (env.STORAGE_PROVIDER === "local") {
    // 注意：这里不要写成 resolve(".data/uploads") 这类带字面量路径的调用。Turbopack 的静态分析会把它当成对项目目录的
    // 文件依赖，开发服务器自己写的 .next/dev/trace 又会触发重新编译，页面因此无限整页重载（实测 8 秒 343 次）。
    // 默认值放在 env.ts 的 zod schema 里，这里的参数对打包器是动态值。
    return createLocalStorage({ dir: resolve(env.STORAGE_LOCAL_DIR), secret });
  }
  return createOssStorage({
    client: createAliyunOssClient({
      accessKeyId: env.ALIYUN_ACCESS_KEY_ID!,
      accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET!,
      region: env.OSS_REGION!,
      bucket: env.OSS_BUCKET!,
    }),
    secret,
  });
}
