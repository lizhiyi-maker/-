"use server";

import { redirect } from "next/navigation";
import { isDemoMode } from "@/lib/env";
import { getServices } from "@/server/container";
import { AuthError } from "@/server/auth/service";
import { normalizePhone } from "@/server/auth/phone";
import { peekMockCode } from "@/server/sms/mock";
import { clearSessionCookie, clientIp, SESSION_COOKIE, setSessionCookie } from "@/server/session";
import { devLogin } from "@/server/dev-login";
import { cookies } from "next/headers";
import { toMessage } from "./shared";

export interface RequestCodeResult {
  ok: boolean;
  error?: string;
  retryAfterSec?: number;
  /** 仅演示模式 + 模拟短信时返回，便于本地体验 */
  demoCode?: string;
}

export async function requestCodeAction(phone: string): Promise<RequestCodeResult> {
  try {
    const { auth, env } = getServices();
    const r = await auth.requestLoginCode(phone, await clientIp());
    const normalized = normalizePhone(phone);
    const demoCode = isDemoMode() && env.SMS_PROVIDER === "mock" && normalized ? peekMockCode(normalized) : undefined;
    return { ok: true, retryAfterSec: Math.ceil(r.retryAfterMs / 1000), demoCode };
  } catch (e) {
    return {
      ok: false,
      error: toMessage(e),
      retryAfterSec: e instanceof AuthError && e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : undefined,
    };
  }
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  needInvite?: boolean;
}

export async function verifyCodeAction(input: { phone: string; code: string; inviteCode?: string }): Promise<VerifyResult> {
  try {
    const { token } = await getServices().auth.verifyLoginCode({ ...input, ip: await clientIp() });
    await setSessionCookie(token);
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthError && e.code === "INVITE_REQUIRED") return { ok: false, needInvite: true, error: e.message };
    return { ok: false, error: toMessage(e) };
  }
}

export async function devLoginAction(kind: "user" | "admin") {
  await setSessionCookie(await devLogin(kind));
  redirect(kind === "admin" ? "/admin" : "/");
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await getServices().auth.logout(token);
  await clearSessionCookie();
  redirect("/login");
}
