import { getEnv } from "@/lib/env";
import { getDb } from "@/server/db";
import { createAccount } from "@/server/account/service";
import { createAdmin } from "@/server/admin/service";
import { createAnalysis } from "@/server/analysis/service";
import { createAuth } from "@/server/auth/service";
import { createCompare } from "@/server/compare/service";
import { createConsent } from "@/server/consent/service";
import { createEvents } from "@/server/events/service";
import { createExport } from "@/server/export/service";
import { createFeedback } from "@/server/feedback/service";
import { providerInfo } from "@/domain/consent";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPreferences } from "@/server/preferences/service";
import { buildAnalysisModel, buildSms, buildStorage, buildVision } from "@/server/providers";
import { createPgBossQueue } from "@/server/queue";
import { createQuota } from "@/server/quota/ledger";
import { createRecognition } from "@/server/recognition/service";
import { createUsage } from "@/server/usage/service";

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
  const usage = createUsage(db);
  const analysis = createAnalysis(db, {
    quota,
    consent,
    preferences,
    usage,
    model: buildAnalysisModel(env),
    queue: { enqueue: (job) => queue.enqueueAnalysis(job) },
  });
  return {
    env,
    db,
    keys,
    storage,
    auth: createAuth(db, { sms: buildSms(env), keys }),
    provider,
    consent,
    events: createEvents(db),
    exporter: createExport(db),
    account: createAccount(db, { storage }),
    people: createPeople(db, { quota }),
    imports: createImports(db, { storage, quota }),
    recognition: createRecognition(db, { storage, quota, consent, vision: buildVision(env), usage, queue }),
    feedback: createFeedback(db),
    usage,
    analysis,
    compare: createCompare(db, { analysis, preferences }),
    preferences,
    quota,
    admin: createAdmin(db, { keys, usage }),
  };
}

const g = globalThis as unknown as { __services?: ReturnType<typeof build> };

/** 进程内服务容器（开发热重载下复用）。Web 与 worker 共用同一套装配。 */
export function getServices() {
  return (g.__services ??= build());
}
