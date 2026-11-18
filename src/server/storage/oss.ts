import { assertValidKey, createTokenSigner } from "./shared";
import type { FileStorage, StoredObject } from "./types";

/** 我们用到的 ali-oss 客户端方法子集；测试中用内存假实现替换。形状与 ali-oss 一致（含 NoSuchKey 错误码、空桶时 objects 缺失）。 */
export interface OssClient {
  put(name: string, content: Buffer, options: { mime: string; headers: Record<string, string> }): Promise<unknown>;
  get(name: string): Promise<{ content?: unknown }>;
  delete(name: string): Promise<unknown>;
  list(query: { marker?: string; "max-keys": number }): Promise<{
    objects?: { name: string; lastModified: string }[] | null;
    isTruncated?: boolean;
    nextMarker?: string | null;
  }>;
}

/** OSS 请求失败。只带错误码，不带服务商原始消息（可能含密钥 ID、对象路径、请求详情）。 */
export class OssRequestError extends Error {
  constructor(public readonly code: string) {
    super(`对象存储请求失败：${code}`);
    this.name = "OssRequestError";
  }
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(c) ? c : "REQUEST_FAILED";
}

export interface OssStorageOptions {
  client: OssClient;
  /** 令牌签名密钥 */
  secret: string;
  now?: () => Date;
}

const PAGE_SIZE = 1000;
// 防止服务端行为异常造成无限翻页（每页 1000 条，足够覆盖内测规模的孤儿文件清理）
const MAX_PAGES = 10_000;

/**
 * 阿里云 OSS 私有桶实现。桶必须是私有的：下载始终经过应用路由（先校验登录与归属），
 * 应用自己签发短时令牌（见 shared.ts），不使用 OSS 预签名链接。
 * 上传时请求服务端加密（SSE-OSS，AES256）；桶本身的加密/版本控制/生命周期规则需在控制台核实 ⏳。
 */
export function createOssStorage(opts: OssStorageOptions): FileStorage {
  const { client } = opts;
  const tokens = createTokenSigner(opts.secret, opts.now ?? (() => new Date()));

  return {
    async put(key, bytes, contentType) {
      assertValidKey(key);
      try {
        await client.put(key, Buffer.from(bytes), { mime: contentType, headers: { "x-oss-server-side-encryption": "AES256" } });
      } catch (e) {
        throw new OssRequestError(codeOf(e));
      }
    },
    async get(key) {
      assertValidKey(key);
      try {
        const res = await client.get(key);
        return new Uint8Array(res.content as Buffer);
      } catch (e) {
        if (codeOf(e) === "NoSuchKey") return null;
        throw new OssRequestError(codeOf(e));
      }
    },
    async delete(key) {
      assertValidKey(key);
      try {
        await client.delete(key); // OSS 删除不存在的对象也返回成功
      } catch (e) {
        if (codeOf(e) === "NoSuchKey") return;
        throw new OssRequestError(codeOf(e));
      }
    },
    async list() {
      const out: StoredObject[] = [];
      let marker: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await client.list({ marker, "max-keys": PAGE_SIZE });
          for (const o of res.objects ?? []) out.push({ key: o.name, modifiedAt: new Date(o.lastModified) });
          if (!res.isTruncated || !res.nextMarker) break; // 没有游标就无法继续，停止而不是死循环
          marker = res.nextMarker;
        }
      } catch (e) {
        throw new OssRequestError(codeOf(e));
      }
      return out;
    },
    signToken: tokens.signToken,
    verifyToken: tokens.verifyToken,
  };
}

export interface AliyunOssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  /** 例如 oss-cn-hangzhou */
  region: string;
  bucket: string;
  /** 测试用：指向本地假服务 */
  endpoint?: string;
  secure?: boolean;
}

/**
 * 真实的 ali-oss 客户端（官方 SDK）。惰性加载：演示模式与测试里不会加载 SDK。
 * ⏳ 没有在真实桶上验证过（权限、加密、版本控制、生命周期）；行为契约由 storage-oss 测试用假客户端覆盖。
 */
export function createAliyunOssClient(cred: AliyunOssCredentials): OssClient {
  type Sdk = {
    put(name: string, content: Buffer, options: unknown): Promise<unknown>;
    get(name: string): Promise<{ content?: unknown }>;
    delete(name: string): Promise<unknown>;
    list(query: unknown, options: unknown): Promise<ReturnType<OssClient["list"]> extends Promise<infer R> ? R : never>;
  };
  let sdk: Promise<Sdk> | undefined;
  const load = () =>
    (sdk ??= (async () => {
      const mod = (await import("ali-oss")) as unknown as { default: unknown };
      const Ctor = ((mod.default as { default?: unknown }).default ?? mod.default) as new (o: Record<string, unknown>) => Sdk;
      return new Ctor({
        region: cred.region,
        bucket: cred.bucket,
        accessKeyId: cred.accessKeyId,
        accessKeySecret: cred.accessKeySecret,
        secure: cred.secure ?? true,
        ...(cred.endpoint ? { endpoint: cred.endpoint } : {}),
        timeout: 30_000,
      });
    })());

  return {
    async put(name, content, options) {
      return (await load()).put(name, content, options);
    },
    async get(name) {
      return (await load()).get(name);
    },
    async delete(name) {
      return (await load()).delete(name);
    },
    async list(query) {
      return (await load()).list(query, {});
    },
  };
}
