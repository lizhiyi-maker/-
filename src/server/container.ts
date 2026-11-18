import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { getEnv, type Env } from "@/lib/env";
import { getDb } from "@/server/db";
import type { AnalysisModel } from "@/server/ai/analysis-model";
import { createMockAnalysisModel } from "@/server/ai/mock-analysis";
import { createMockVision } from "@/server/ai/mock-vision";
import type { VisionModel } from "@/server/ai/vision";
import { createAccount } from "@/server/account/service";
import { createAdmin } from "@/server/admin/service";
import { createAnalysis } from "@/server/analysis/service";
import { createAuth } from "@/server/auth/service";
import { createCompare } from "@/server/compare/service";
import { createConsent } from "@/server/consent/service";
import { createEvents } from "@/server/events/service";
import { createExport } from "@/server/export/service";
import { providerInfo } from "@/domain/consent";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createPgBossQueue } from "@/server/queue";
import { createQuota } from "@/server/quota/ledger";
import { createRecognition } from "@/server/recognition/service";
import { mockSms } from "@/server/sms/mock";
import type { SmsSender } from "@/server/sms/types";
import { createLocalStorage } from "@/server/storage/local";
import type { FileStorage } from "@/server/storage/types";

// 真实服务（短信、对象存储、视觉模型）尚未接入：见 docs/verification-matrix.md（⏳ 待真实服务）。
function buildSms(provider: string): SmsSender {
  if (provider === "mock") return mockSms;
  throw new Error(`短信提供方 ${provider} 尚未实现`);
}

function buildStorage(env: Env): FileStorage {
  if (env.STORAGE_PROVIDER === "local") {
    // 签名密钥由 AUTH_SECRET 派生，不直接复用
    const secret = createHmac("sha256", env.AUTH_SECRET).update("file-url-signing").digest("hex");
    // 注意：这里不要写成 resolve(".data/uploads") 这类带字面量路径的调用。Turbopack 的静态分析会把它当成对项目目录的
    // 文件依赖，开发服务器自己写的 .next/dev/trace 又会触发重新编译，页面因此无限整页重载（实测 8 秒 343 次）。
    // 默认值放在 env.ts 的 zod schema 里，这里的参数对打包器是动态值。
    return createLocalStorage({ dir: resolve(env.STORAGE_LOCAL_DIR), secret });
  }
  throw new Error(`存储提供方 ${env.STORAGE_PROVIDER} 尚未实现`);
}

function buildVision(env: Env): VisionModel {
  if (env.AI_PROVIDER === "mock") return createMockVision();
  throw new Error(`AI 提供方 ${env.AI_PROVIDER} 尚未实现`);
}

function buildAnalysisModel(env: Env): AnalysisModel {
  if (env.AI_PROVIDER === "mock") return createMockAnalysisModel();
  throw new Error(`AI 提供方 ${env.AI_PROVIDER} 尚未实现`);
}

function build() {
  const env = getEnv();
  const db = getDb();
  const keys = { hmacKey: env.PHONE_HMAC_KEY, encKey: env.PHONE_ENC_KEY };
  const storage = buildStorage(env);
  const quota = createQuota(db);
  const queue = createPgBossQueue(env.DATABASE_URL);
  const provider = providerInfo(env.AI_PROVIDER);
  const consent = createConsent(db, { providerId: provider.id });
  const preferences = createPreferences(db);
  const analysis = createAnalysis(db, {
    quota,
    consent,
    preferences,
    model: buildAnalysisModel(env),
    queue: { enqueue: (job) => queue.enqueueAnalysis(job) },
  });
  return {
    env,
    db,
    keys,
    storage,
    auth: createAuth(db, { sms: buildSms(env.SMS_PROVIDER), keys }),
    provider,
    consent,
    events: createEvents(db),
    exporter: createExport(db),
    account: createAccount(db, { storage }),
    people: createPeople(db, { quota }),
    imports: createImports(db, { storage, quota }),
    recognition: createRecognition(db, { storage, quota, consent, vision: buildVision(env), queue }),
    analysis,
    compare: createCompare(db, { analysis, preferences }),
    preferences,
    quota,
    admin: createAdmin(db, { keys }),
  };
}

const g = globalThis as unknown as { __services?: ReturnType<typeof build> };

/** 进程内服务容器（开发热重载下复用）。Web 与 worker 共用同一套装配。 */
export function getServices() {
  return (g.__services ??= build());
}
