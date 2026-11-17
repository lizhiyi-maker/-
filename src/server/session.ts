import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { pickClientIp } from "@/server/client-ip";
import { getServices } from "@/server/container";
import { authConfig, type SessionUser } from "@/server/auth/service";

export const SESSION_COOKIE = "rel_session";

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(authConfig.sessionTtlMs / 1000),
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** 每个请求只查询一次会话。 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getServices().auth.getSessionUser(token);
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** 非管理员一律返回 404，不暴露后台入口的存在。 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") notFound();
  return user;
}

/** 客户端 IP 仅在配置了可信代理跳数（TRUSTED_PROXY_HOPS）时才从 X-Forwarded-For 获取，否则为 null。 */
export async function clientIp(): Promise<string | null> {
  return pickClientIp((await headers()).get("x-forwarded-for"), getServices().env.TRUSTED_PROXY_HOPS);
}
