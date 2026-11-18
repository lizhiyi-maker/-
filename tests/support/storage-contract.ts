import { describe, expect, it } from "vitest";
import type { FileStorage } from "@/server/storage/types";

export interface ContractFactory {
  /** 每个用例都新建一个存储；now 用于令牌过期测试 */
  (opts: { secret: string; now: () => Date }): FileStorage;
}

const secret = "test-storage-signing-secret-0123456789";
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

/**
 * 私有存储的行为契约：本地模拟与 OSS 适配器必须表现一致，调用方（导入、识别、清理任务）只依赖这些行为。
 */
export function describeStorageContract(title: string, make: ContractFactory) {
  const fresh = (now: () => Date = () => new Date()) => make({ secret, now });

  describe(title, () => {
    it("存、取、删；取不存在的对象返回空", async () => {
      const st = fresh();
      await st.put("u/a/b/1", bytes("hello"), "image/png");
      expect(Buffer.from((await st.get("u/a/b/1"))!).toString()).toBe("hello");
      await st.delete("u/a/b/1");
      expect(await st.get("u/a/b/1")).toBeNull();
      await st.delete("u/a/b/1"); // 重复删除不报错
    });

    it("二进制内容原样存取（不经过文本编码）", async () => {
      const st = fresh();
      const raw = new Uint8Array([0, 255, 128, 10, 13, 0xef, 0xbb, 0xbf, 1]);
      await st.put("u/bin/1", raw, "image/png");
      expect(Array.from((await st.get("u/bin/1"))!)).toEqual(Array.from(raw));
    });

    it("拒绝试图逃出存储目录的 key", async () => {
      const st = fresh();
      for (const key of ["../evil", "u/../../evil", "/abs", "a\b", ""]) {
        await expect(st.put(key, bytes("x"), "image/png")).rejects.toThrow();
        await expect(st.get(key)).rejects.toThrow();
        await expect(st.delete(key)).rejects.toThrow();
      }
    });

    it("签名链接在有效期内可验证出 key；过期后拒绝", () => {
      let now = new Date("2026-03-01T00:00:00Z");
      const st = fresh(() => now);
      const token = st.signToken("u/a/b/1", 300);
      expect(st.verifyToken(token)).toBe("u/a/b/1");
      now = new Date("2026-03-01T00:04:59Z");
      expect(st.verifyToken(token)).toBe("u/a/b/1");
      now = new Date("2026-03-01T00:05:01Z");
      expect(st.verifyToken(token)).toBeNull();
    });

    it("被篡改的链接、换了签名密钥的链接、乱码都拒绝", () => {
      const st = fresh();
      const token = st.signToken("u/a/b/1", 300);
      const [payload, sig] = token.split(".");
      const forged = Buffer.from(JSON.stringify({ k: "u/other/b/1", e: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
      expect(st.verifyToken(`${forged}.${sig}`)).toBeNull();
      expect(st.verifyToken(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
      expect(make({ secret: "another-secret-0123456789abcdef0123", now: () => new Date() }).verifyToken(token)).toBeNull();
      for (const junk of ["", "abc", "a.b", "..", `${payload}`]) expect(st.verifyToken(junk)).toBeNull();
    });

    it("列出已存对象（含修改时间），供清理孤儿文件使用", async () => {
      const st = fresh();
      await st.put("u/x/1/a", bytes("1"), "image/png");
      await st.put("u/x/1/b", bytes("2"), "image/png");
      const listed = await st.list();
      expect(listed.map((o) => o.key)).toEqual(expect.arrayContaining(["u/x/1/a", "u/x/1/b"]));
      expect(listed[0].modifiedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(listed[0].modifiedAt.getTime())).toBe(false);
    });

    it("删除后不再出现在列表里", async () => {
      const st = fresh();
      await st.put("u/y/1/a", bytes("1"), "image/png");
      await st.delete("u/y/1/a");
      expect((await st.list()).map((o) => o.key)).not.toContain("u/y/1/a");
    });
  });
}
