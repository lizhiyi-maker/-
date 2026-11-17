import { getEnv } from "@/lib/env";
import { getDb } from "@/server/db";
import { createAdmin } from "@/server/admin/service";
import { createAuth } from "@/server/auth/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { createQuota } from "@/server/quota/ledger";
import { mockSms } from "@/server/sms/mock";
import type { SmsSender } from "@/server/sms/types";

function buildSms(provider: string): SmsSender {
  if (provider === "mock") return mockSms;
  // 真实短信服务（阿里云）尚未接入：见 docs/verification-matrix.md（⏳ 待真实服务）。
  throw new Error(`短信提供方 ${provider} 尚未实现`);
}

function build() {
  const env = getEnv();
  const db = getDb();
  const keys = { hmacKey: env.PHONE_HMAC_KEY, encKey: env.PHONE_ENC_KEY };
  return {
    env,
    db,
    keys,
    auth: createAuth(db, { sms: buildSms(env.SMS_PROVIDER), keys }),
    people: createPeople(db),
    imports: createImports(db),
    preferences: createPreferences(db),
    quota: createQuota(db),
    admin: createAdmin(db, { keys }),
  };
}

const g = globalThis as unknown as { __services?: ReturnType<typeof build> };

/** 进程内服务容器（开发热重载下复用）。 */
export function getServices() {
  return (g.__services ??= build());
}
