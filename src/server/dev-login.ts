import "server-only";
import { devLoginAllowed } from "@/lib/env";
import { getServices } from "@/server/container";
import { encryptPhone, hashPhone } from "@/server/auth/phone";

const DEMO_PHONES = { user: "13800000000", admin: "13800000001" } as const;

/**
 * 演示模式开发登录：直接为内置演示账号建立会话，跳过短信与邀请码。
 * 每次调用都重新校验环境；生产环境（或未开启）一律拒绝。
 */
export async function devLogin(kind: "user" | "admin"): Promise<string> {
  const { env, db, auth, keys } = getServices();
  if (!devLoginAllowed(env)) throw new Error("开发登录不可用");
  const phone = DEMO_PHONES[kind];
  const phoneHash = hashPhone(phone, keys.hmacKey);
  const user = await db.user.upsert({
    where: { phoneHash },
    create: { phoneHash, phoneEnc: encryptPhone(phone, keys.encKey), role: kind === "admin" ? "ADMIN" : "USER" },
    update: { lastLoginAt: new Date(), status: "ACTIVE" },
  });
  return auth.createSession(user.id);
}
