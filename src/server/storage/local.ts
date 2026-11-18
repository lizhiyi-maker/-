import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertValidKey, createTokenSigner } from "./shared";
import type { FileStorage, StoredObject } from "./types";

export interface LocalStorageOptions {
  dir: string;
  /** 令牌签名密钥 */
  secret: string;
  now?: () => Date;
}

/** 本地文件系统实现，仅用于开发与测试（演示模式）。 */
export function createLocalStorage(opts: LocalStorageOptions): FileStorage {
  const root = resolve(opts.dir);
  const now = opts.now ?? (() => new Date());

  function pathOf(key: string): string {
    assertValidKey(key);
    const full = resolve(root, ...key.split("/"));
    if (!full.startsWith(root + sep)) throw new Error("非法的存储 key");
    return full;
  }

  const tokens = createTokenSigner(opts.secret, now);

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
    signToken: tokens.signToken,
    verifyToken: tokens.verifyToken,
  };
}
