import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createAliyunSms, createAliyunSmsApi, SmsSendError, type SmsApi, type SmsApiRequest } from "@/server/sms/aliyun";

const PHONE = "13800138000";
const CODE = "654321";

function fakeApi(reply: (req: SmsApiRequest) => Promise<{ code?: string; message?: string }>) {
  const calls: SmsApiRequest[] = [];
  const api: SmsApi = {
    async sendSms(req) {
      calls.push(req);
      return reply(req);
    },
  };
  return { api, calls };
}
const sms = (api: SmsApi, over: Partial<Parameters<typeof createAliyunSms>[0]> = {}) =>
  createAliyunSms({ api, signName: "关系工作台", templateCode: "SMS_123456", ...over });

/** 把错误里能看到的一切（消息、字段、cause、序列化）拼起来，用来断言不含敏感信息。 */
async function leaks(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { code?: string };
    return [String(err.message), String(err.code), JSON.stringify(e, Object.getOwnPropertyNames(e)), String((err as { cause?: unknown }).cause)].join(" | ");
  }
  throw new Error("预期失败却成功了");
}

describe("阿里云短信适配器", () => {
  it("把手机号、签名、模板与验证码映射到服务商参数（验证码放在模板变量里）", async () => {
    const { api, calls } = fakeApi(async () => ({ code: "OK", message: "OK" }));
    await sms(api).send(PHONE, CODE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      phoneNumbers: PHONE,
      signName: "关系工作台",
      templateCode: "SMS_123456",
      templateParam: JSON.stringify({ code: CODE }),
    });
  });

  it("模板变量名可配置（审核通过的模板里变量不一定叫 code）", async () => {
    const { api, calls } = fakeApi(async () => ({ code: "OK" }));
    await sms(api, { paramName: "verifyCode" }).send(PHONE, CODE);
    expect(JSON.parse(calls[0].templateParam)).toEqual({ verifyCode: CODE });
  });

  it("服务商返回非 OK（限流、签名/模板不合法、余额不足…）：抛出带服务商错误码的失败，且不含手机号与验证码", async () => {
    for (const code of ["isv.BUSINESS_LIMIT_CONTROL", "isv.SMS_SIGNATURE_ILLEGAL", "isv.AMOUNT_NOT_ENOUGH"]) {
      const { api } = fakeApi(async () => ({ code, message: `手机号 ${PHONE} 验证码 ${CODE} 失败` }));
      const seen = await leaks(sms(api).send(PHONE, CODE));
      expect(seen).toContain(code);
      expect(seen).not.toContain(PHONE);
      expect(seen).not.toContain(CODE);
    }
  });

  it("服务商返回的错误是 SmsSendError，带稳定的 code 字段供日志/排障", async () => {
    const { api } = fakeApi(async () => ({ code: "isv.BUSINESS_LIMIT_CONTROL" }));
    await expect(sms(api).send(PHONE, CODE)).rejects.toMatchObject({ name: "SmsSendError", code: "isv.BUSINESS_LIMIT_CONTROL" });
    await expect(sms(api).send(PHONE, CODE)).rejects.toBeInstanceOf(SmsSendError);
  });

  it("响应里没有状态码也算失败（不能把“不知道”当成功）", async () => {
    const { api } = fakeApi(async () => ({}));
    await expect(sms(api).send(PHONE, CODE)).rejects.toMatchObject({ code: "NO_RESPONSE_CODE" });
  });

  it("网络/SDK 异常：失败，且原始异常（可能带手机号、密钥 ID）不外泄", async () => {
    const { api } = fakeApi(async () => {
      throw new Error(`connect ECONNRESET, phone=${PHONE}, code=${CODE}, AccessKeyId=LTAIsecretid`);
    });
    const seen = await leaks(sms(api).send(PHONE, CODE));
    expect(seen).toContain("REQUEST_FAILED");
    expect(seen).not.toMatch(/ECONNRESET|LTAIsecretid/);
    expect(seen).not.toContain(PHONE);
    expect(seen).not.toContain(CODE);
  });

  it("服务商长时间不响应：超时失败，不会让登录请求一直挂着", async () => {
    const { api } = fakeApi(() => new Promise(() => {}));
    await expect(sms(api, { timeoutMs: 20 }).send(PHONE, CODE)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("真实官方 SDK 接线（对本地假服务；不验证签名是否被阿里云接受）", () => {
  it("SDK 发出带 ACS3 签名头的请求，参数与模板变量齐全；服务商的 Code 被正确读回并映射为失败", async () => {
    const seen: { url?: string; auth?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, auth: String(req.headers.authorization) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Code: "isv.BUSINESS_LIMIT_CONTROL", Message: "限流", RequestId: "r1" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const real = createAliyunSms({
        api: createAliyunSmsApi({ accessKeyId: "test-id", accessKeySecret: "test-secret", endpoint: `127.0.0.1:${port}`, protocol: "http" }),
        signName: "关系工作台",
        templateCode: "SMS_123456",
      });
      await expect(real.send(PHONE, CODE)).rejects.toMatchObject({ code: "isv.BUSINESS_LIMIT_CONTROL" });
      expect(seen).toHaveLength(1);
      const url = new URL(seen[0].url!, "http://x");
      expect(url.searchParams.get("PhoneNumbers")).toBe(PHONE);
      expect(url.searchParams.get("SignName")).toBe("关系工作台");
      expect(url.searchParams.get("TemplateCode")).toBe("SMS_123456");
      expect(JSON.parse(url.searchParams.get("TemplateParam")!)).toEqual({ code: CODE });
      expect(seen[0].auth).toMatch(/^ACS3-HMAC-SHA256 Credential=test-id,/);
      expect(seen[0].auth).not.toContain("test-secret"); // 密钥只用于签名，不出现在请求里
    } finally {
      server.close();
    }
  });
});
