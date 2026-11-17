import type { Db } from "@/server/db";
import { encryptPhone, hashPhone, normalizePhone } from "@/server/auth/phone";

/**
 * 引导首个管理员（生产环境没有演示登录）：按手机号创建或提升为管理员并确保启用。
 * 管理员之后用验证码登录，无需邀请码。
 */
export async function ensureAdmin(db: Db, rawPhone: string, keys: { hmacKey: string; encKey: string }) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error("手机号无效");
  const phoneHash = hashPhone(phone, keys.hmacKey);
  const existing = await db.user.findUnique({ where: { phoneHash } });
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { role: "ADMIN", status: "ACTIVE" } });
    return { userId: existing.id, created: false };
  }
  const user = await db.user.create({
    data: { phoneHash, phoneEnc: encryptPhone(phone, keys.encKey), role: "ADMIN" },
  });
  return { userId: user.id, created: true };
}
