import { describe, expect, it } from "vitest";
import { pickClientIp } from "@/server/client-ip";

describe("可信代理下的客户端 IP", () => {
  it("未配置可信代理（跳数 0）时忽略 X-Forwarded-For，防止伪造", () => {
    expect(pickClientIp("6.6.6.6", 0)).toBeNull();
  });

  it("跳数 1：取最靠右的一项（可信代理追加的），忽略客户端自填的靠左项", () => {
    expect(pickClientIp("1.1.1.1, 2.2.2.2, 203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("跳数 2：取从右数第二项（再往右是我们自己的代理）", () => {
    expect(pickClientIp("1.1.1.1, 203.0.113.9, 10.0.0.2", 2)).toBe("203.0.113.9");
  });

  it("链路比声明的代理层数短、头缺失或为空时返回空，而不是回退到可伪造的值", () => {
    expect(pickClientIp("203.0.113.9", 2)).toBeNull();
    expect(pickClientIp(null, 1)).toBeNull();
    expect(pickClientIp("  ,  ", 1)).toBeNull();
  });
});
