import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import { encryptPhone } from "@/server/auth/phone";
import { testKeys } from "./keys";

let seq = 0;

/** 直接创建用户（绕过登录流程）；手机号按真实方式加密，便于管理列表等场景解密脱敏。 */
export async function makeUser(db: Db, over: { role?: "USER" | "ADMIN"; status?: "ACTIVE" | "SUSPENDED"; createdAt?: Date } = {}) {
  const id = randomUUID();
  const phone = `130${String(10_000_000 + seq++).slice(-8)}`;
  return db.user.create({
    data: {
      id,
      phoneHash: `hash-${id}`,
      phoneEnc: encryptPhone(phone, testKeys.encKey),
      role: over.role,
      status: over.status,
      createdAt: over.createdAt,
    },
  });
}
