import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createAliyunOssClient, createOssStorage, type OssClient } from "@/server/storage/oss";
import { describeStorageContract } from "../support/storage-contract";

/** 内存里的假 OSS 客户端：行为照 ali-oss（不存在时 get 抛 code=NoSuchKey；列表分页；空桶 objects 为 undefined）。 */
function fakeOss(opts: { pageSize?: number } = {}) {
  const store = new Map<string, { body: Buffer; modified: Date; mime?: string; headers?: Record<string, string> }>();
  const calls: string[] = [];
  const client: OssClient = {
    async put(name, content, options) {
      calls.push(`put:${name}`);
      store.set(name, { body: Buffer.from(content), modified: new Date(), mime: options?.mime, headers: options?.headers as Record<string, string> });
    },
    async get(name) {
      calls.push(`get:${name}`);
      const o = store.get(name);
      if (!o) throw Object.assign(new Error("The specified key does not exist."), { code: "NoSuchKey", status: 404 });
      return { content: o.body };
    },
    async delete(name) {
      calls.push(`delete:${name}`);
      store.delete(name);
    },
    async list(query) {
      calls.push(`list:${query.marker ?? ""}`);
      const names = [...store.keys()].sort().filter((n) => !query.marker || n > query.marker);
      const page = names.slice(0, opts.pageSize ?? 1000);
      const truncated = names.length > page.length;
      return {
        objects: page.length ? page.map((n) => ({ name: n, lastModified: store.get(n)!.modified.toISOString() })) : undefined,
        isTruncated: truncated,
        nextMarker: truncated ? page[page.length - 1] : "",
      };
    },
  };
  return { client, store, calls };
}

describeStorageContract("私有存储契约 · OSS 适配器（假客户端）", (o) => createOssStorage({ client: fakeOss().client, ...o }));

describe("OSS 适配器的特有行为", () => {
  const make = (client: OssClient) => createOssStorage({ client, secret: "test-storage-signing-secret-0123456789" });

  it("上传时带内容类型与服务端加密头（AES256）", async () => {
    const f = fakeOss();
    await make(f.client).put("u/a/1", new Uint8Array([1, 2, 3]), "image/webp");
    const o = f.store.get("u/a/1")!;
    expect(o.mime).toBe("image/webp");
    expect(o.headers).toMatchObject({ "x-oss-server-side-encryption": "AES256" });
  });

  it("非法 key 在调用 OSS 之前就被拒绝（不会向桶发请求）", async () => {
    const f = fakeOss();
    await expect(make(f.client).get("../evil")).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it("只有“对象不存在”被当作 null；权限不足、网络错误照常抛出，且错误里没有服务商原始信息（可能含密钥 ID）", async () => {
    const f = fakeOss();
    f.client.get = async () => {
      throw Object.assign(new Error("AccessDenied: AccessKeyId LTAIsecretid is not allowed, key=u/a/1"), { code: "AccessDenied", status: 403 });
    };
    const err = await make(f.client).get("u/a/1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("AccessDenied");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("LTAIsecretid");

    f.client.get = async () => {
      throw new Error("socket hang up");
    };
    const err2 = await make(f.client).get("u/a/1").catch((e: Error) => e);
    expect((err2 as Error).message).toContain("REQUEST_FAILED");
    expect((err2 as Error).message).not.toContain("socket hang up");
  });

  it("列表跨多页：全部取回，空桶返回空数组", async () => {
    const f = fakeOss({ pageSize: 2 });
    const st = make(f.client);
    expect(await st.list()).toEqual([]);
    for (const n of ["u/a/1", "u/a/2", "u/a/3", "u/a/4", "u/a/5"]) await st.put(n, new Uint8Array([1]), "image/png");
    const keys = (await st.list()).map((o) => o.key).sort();
    expect(keys).toEqual(["u/a/1", "u/a/2", "u/a/3", "u/a/4", "u/a/5"]);
    expect(f.calls.filter((c) => c.startsWith("list:")).length).toBe(4); // 空桶 1 次 + 三页
  });

  it("服务端说“还有下一页”却不给游标：停止翻页，不死循环", async () => {
    const f = fakeOss();
    let n = 0;
    f.client.list = async () => {
      n++;
      return { objects: [{ name: "u/a/1", lastModified: new Date().toISOString() }], isTruncated: true, nextMarker: "" };
    };
    const listed = await make(f.client).list();
    expect(listed).toHaveLength(1);
    expect(n).toBe(1);
  });
});

describe("真实 ali-oss SDK 接线（对本地假服务；不验证签名是否被阿里云接受）", () => {
  it("SDK 发出带签名与服务端加密头的上传/删除请求；404 NoSuchKey 被读成“不存在”", async () => {
    const seen: { method?: string; url?: string; sse?: unknown; contentType?: unknown; auth?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, sse: req.headers["x-oss-server-side-encryption"], contentType: req.headers["content-type"], auth: String(req.headers.authorization) });
      req.resume();
      req.on("end", () => {
        if (req.method === "GET") {
          res.statusCode = 404;
          res.setHeader("content-type", "application/xml");
          res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>nope</Message></Error>');
          return;
        }
        res.statusCode = req.method === "DELETE" ? 204 : 200;
        res.setHeader("etag", '"abc"');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const st = createOssStorage({
        client: createAliyunOssClient({ accessKeyId: "test-id", accessKeySecret: "test-secret", region: "oss-cn-hangzhou", bucket: "test-bucket", endpoint: `http://127.0.0.1:${port}`, secure: false }),
        secret: "x".repeat(40),
      });
      await st.put("u/a/1", new Uint8Array([1, 2, 3]), "image/png");
      expect(await st.get("u/missing/1")).toBeNull();
      await st.delete("u/a/1");
      const put = seen.find((r) => r.method === "PUT")!;
      expect(put.url).toContain("u/a/1");
      expect(put.sse).toBe("AES256");
      expect(put.contentType).toBe("image/png");
      expect(put.auth).toMatch(/^OSS test-id:/);
      expect(JSON.stringify(seen)).not.toContain("test-secret");
      expect(seen.some((r) => r.method === "DELETE")).toBe(true);
    } finally {
      server.close();
    }
  });
});
