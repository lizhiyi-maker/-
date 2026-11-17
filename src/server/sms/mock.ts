import type { SmsSender } from "./types";

// 仅演示模式使用的模拟短信：验证码只保存在进程内存，不写日志、不落库。
const store = ((globalThis as unknown as { __mockSms?: Map<string, string> }).__mockSms ??= new Map());

export const mockSms: SmsSender = {
  async send(phone, code) {
    store.set(phone, code);
  },
};

/** 供演示页面提示验证码；调用方必须先确认处于演示模式。 */
export function peekMockCode(phone: string): string | undefined {
  return store.get(phone);
}
