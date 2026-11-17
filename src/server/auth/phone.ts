import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/** 归一化中国大陆手机号：接受 138…、+86138…、带空格或短横线；非法返回 null。 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "").replace(/^(\+?86)/, "");
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}

/** HMAC 索引：用于唯一查找与限流键，不可逆。 */
export function hashPhone(phone: string, hmacKey: string): string {
  return createHmac("sha256", hmacKey).update(`phone:${phone}`).digest("hex");
}

const aesKey = (encKey: string) => createHash("sha256").update(encKey).digest();

/** AES-256-GCM 加密：返回 base64(iv | tag | ciphertext)。 */
export function encryptPhone(phone: string, encKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(encKey), iv);
  const ct = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptPhone(payload: string, encKey: string): string {
  const buf = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", aesKey(encKey), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
