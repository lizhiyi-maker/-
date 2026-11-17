import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalStorage } from "@/server/storage/local";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rel-storage-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const secret = "test-storage-signing-secret-0123456789";
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe("私有存储（本地模拟实现）", () => {
  it("存、取、删；取不存在的对象返回空", async () => {
    const st = createLocalStorage({ dir, secret });
    await st.put("u/a/b/1", bytes("hello"), "image/png");
    expect(Buffer.from((await st.get("u/a/b/1"))!).toString()).toBe("hello");
    await st.delete("u/a/b/1");
    expect(await st.get("u/a/b/1")).toBeNull();
    await st.delete("u/a/b/1"); // 重复删除不报错
  });

  it("拒绝试图逃出存储目录的 key", async () => {
    const st = createLocalStorage({ dir, secret });
    for (const key of ["../evil", "u/../../evil", "/abs", "a\b", ""]) {
      await expect(st.put(key, bytes("x"), "image/png")).rejects.toThrow();
      await expect(st.get(key)).rejects.toThrow();
    }
  });

  it("签名链接在有效期内可验证出 key；过期后拒绝", () => {
    let now = new Date("2026-03-01T00:00:00Z");
    const st = createLocalStorage({ dir, secret, now: () => now });
    const token = st.signToken("u/a/b/1", 300);
    expect(st.verifyToken(token)).toBe("u/a/b/1");
    now = new Date("2026-03-01T00:04:59Z");
    expect(st.verifyToken(token)).toBe("u/a/b/1");
    now = new Date("2026-03-01T00:05:01Z");
    expect(st.verifyToken(token)).toBeNull();
  });

  it("被篡改的链接、换了签名密钥的链接、乱码都拒绝", () => {
    const st = createLocalStorage({ dir, secret });
    const token = st.signToken("u/a/b/1", 300);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "u/other/b/1", e: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    expect(st.verifyToken(`${forged}.${sig}`)).toBeNull();
    expect(st.verifyToken(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(createLocalStorage({ dir, secret: "another-secret-0123456789abcdef0123" }).verifyToken(token)).toBeNull();
    for (const junk of ["", "abc", "a.b", "..", `${payload}`]) expect(st.verifyToken(junk)).toBeNull();
  });

  it("列出已存对象，供清理孤儿文件使用", async () => {
    const st = createLocalStorage({ dir, secret });
    await st.put("u/x/1/a", bytes("1"), "image/png");
    await st.put("u/x/1/b", bytes("2"), "image/png");
    const listed = (await st.list()).map((o) => o.key);
    expect(listed).toEqual(expect.arrayContaining(["u/x/1/a", "u/x/1/b"]));
    expect((await st.list())[0].modifiedAt).toBeInstanceOf(Date);
  });
});
