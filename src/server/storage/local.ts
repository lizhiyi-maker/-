import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FileStorage, StoredObject } from "./types";

export interface LocalStorageOptions {
  dir: string;
  /** 令牌签名密钥 */
  secret: string;
  now?: () => Date;
}

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

/** 本地文件系统实现，仅用于开发与测试（演示模式）。 */
export function createLocalStorage(opts: LocalStorageOptions): FileStorage {
  const root = resolve(opts.dir);
  const now = opts.now ?? (() => new Date());

  function pathOf(key: string): string {
    if (!KEY_RE.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("非法的存储 key");
    }
    const full = resolve(root, ...key.split("/"));
    if (!full.startsWith(root + sep)) throw new Error("非法的存储 key");
    return full;
  }

  const sign = (payload: string) => createHmac("sha256", opts.secret).update(`file-token:${payload}`).digest("base64url");

  async function walk(dir: string, prefix: string, out: StoredObject[]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const key = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, key, out);
      else out.push({ key, modifiedAt: (await stat(full)).mtime });
    }
  }

  return {
    async put(key, bytes) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      const p = pathOf(key);
      try {
        return new Uint8Array(await readFile(p));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
    async list() {
      const out: StoredObject[] = [];
      await walk(root, "", out);
      return out;
    },
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
