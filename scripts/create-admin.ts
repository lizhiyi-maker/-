import { getEnv } from "../src/lib/env";
import { createDb } from "../src/server/db";
import { ensureAdmin } from "../src/server/admin/bootstrap";

const phone = process.argv[2];
if (!phone) {
  console.error("用法：npm run admin:create -- <手机号>");
  process.exit(1);
}

const env = getEnv();
const db = createDb(env.DATABASE_URL);
try {
  const r = await ensureAdmin(db, phone, { hmacKey: env.PHONE_HMAC_KEY, encKey: env.PHONE_ENC_KEY });
  console.log(r.created ? "已创建管理员" : "已将现有用户设为管理员并启用");
} finally {
  await db.$disconnect();
}
