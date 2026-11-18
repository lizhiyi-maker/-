import { createHmac, timingSafeEqual } from "node:crypto";

// 所有存储实现共用：key 规则与短时访问令牌。令牌由应用自己签发和校验（不是 OSS 的预签名链接）：
// 下载始终经过应用的路由，在那里先校验登录与归属，再读取对象，所以桶可以保持完全私有。

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

/** key 只允许字母数字、下划线、连字符与点，按“/”分段；拒绝 .、..、绝对路径、空段。非法则抛错。 */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("非法的存储 key");
  }
}

export interface TokenSigner {
  signToken(key: string, ttlSeconds: number): string;
  verifyToken(token: string): string | null;
}

export function createTokenSigner(secret: string, now: () => Date): TokenSigner {
  const sign = (payload: string) => createHmac("sha256", secret).update(`file-token:${payload}`).digest("base64url");
  return {
    signToken(key, ttlSeconds) {
      const payload = Buffer.from(JSON.stringify({ k: key, e: Math.floor(now().getTime() / 1000) + ttlSeconds })).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    verifyToken(token) {
      const [payload, sig, extra] = token.split(".");
      if (!payload || !sig || extra !== undefined) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const { k, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { k?: unknown; e?: unknown };
        if (typeof k !== "string" || typeof e !== "number") return null;
        return e * 1000 > now().getTime() ? k : null;
      } catch {
        return null;
      }
    },
  };
}
