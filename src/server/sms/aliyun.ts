import type { SmsSender } from "./types";

/** 传给服务商 SendSms 的参数（只含我们用到的字段）。 */
export interface SmsApiRequest {
  phoneNumbers: string;
  signName: string;
  templateCode: string;
  /** JSON 字符串，如 {"code":"123456"} */
  templateParam: string;
}

export interface SmsApiResponse {
  /** 服务商状态码，"OK" 表示成功 */
  code?: string;
  message?: string;
}

/** 对阿里云短信 SDK 的最薄封装；测试中用假实现替换。 */
export interface SmsApi {
  sendSms(req: SmsApiRequest): Promise<SmsApiResponse>;
}

/**
 * 短信发送失败。只带稳定的错误码（服务商状态码或本地原因），**不带**服务商返回的 message 和原始异常：
 * 它们可能含手机号、验证码或密钥 ID，而错误会被框架记入日志。
 */
export class SmsSendError extends Error {
  constructor(public readonly code: string) {
    super(`短信发送失败：${code}`);
    this.name = "SmsSendError";
  }
}

export interface AliyunSmsOptions {
  api: SmsApi;
  signName: string;
  templateCode: string;
  /** 模板里验证码变量的名字，默认 code */
  paramName?: string;
  timeoutMs?: number;
}

export function createAliyunSms(opts: AliyunSmsOptions): SmsSender {
  const paramName = opts.paramName ?? "code";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async send(phone, code) {
      const request: SmsApiRequest = {
        phoneNumbers: phone,
        signName: opts.signName,
        templateCode: opts.templateCode,
        templateParam: JSON.stringify({ [paramName]: code }),
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmsSendError("TIMEOUT")), timeoutMs);
      });
      let res: SmsApiResponse;
      try {
        res = await Promise.race([opts.api.sendSms(request), timeout]);
      } catch (e) {
        if (e instanceof SmsSendError) throw e;
        throw new SmsSendError("REQUEST_FAILED"); // 有意丢弃原始异常，见 SmsSendError 的注释
      } finally {
        clearTimeout(timer);
      }
      if (!res.code) throw new SmsSendError("NO_RESPONSE_CODE");
      if (res.code !== "OK") throw new SmsSendError(res.code);
    },
  };
}

export interface AliyunSmsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  /** 默认 dysmsapi.aliyuncs.com；测试时可指向本地假服务（配合 protocol: "http"） */
  endpoint?: string;
  protocol?: "https" | "http";
}

/**
 * 真实的阿里云短信客户端（官方 SDK）。惰性加载：演示模式与测试里不会加载 SDK。
 * ⏳ 这一层没有在真实服务上验证过（需要通过审核的签名与模板）；参数映射与错误处理由 createAliyunSms 的单测覆盖。
 */
export function createAliyunSmsApi(cred: AliyunSmsCredentials): SmsApi {
  type SdkClient = { sendSms(req: unknown): Promise<{ body?: { code?: string; message?: string } }> };
  let client: Promise<{ client: SdkClient; Request: new (m: Record<string, unknown>) => unknown }> | undefined;

  function load() {
    return (client ??= (async () => {
      const mod = await import("@alicloud/dysmsapi20170525");
      // CJS 包经不同加载器可能多包一层 default
      const m = mod as unknown as { default: unknown; SendSmsRequest: new (m: Record<string, unknown>) => unknown };
      const Ctor = ((m.default as { default?: unknown }).default ?? m.default) as new (c: Record<string, unknown>) => SdkClient;
      return {
        client: new Ctor({
          accessKeyId: cred.accessKeyId,
          accessKeySecret: cred.accessKeySecret,
          endpoint: cred.endpoint ?? "dysmsapi.aliyuncs.com",
          protocol: cred.protocol ?? "https",
          connectTimeout: 5000,
          readTimeout: 8000,
        }),
        Request: m.SendSmsRequest,
      };
    })());
  }

  return {
    async sendSms(req) {
      const { client: c, Request } = await load();
      const res = await c.sendSms(new Request({ ...req }));
      return { code: res.body?.code, message: res.body?.message };
    },
  };
}
