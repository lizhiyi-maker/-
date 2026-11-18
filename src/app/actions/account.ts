"use server";

import { redirect } from "next/navigation";
import { DELETE_CONFIRM_TEXT } from "@/domain/account";
import { getServices } from "@/server/container";
import { clearSessionCookie, requireUser } from "@/server/session";
import { str, toMessage, type FormState } from "./shared";

/** 立即停用并删除全部在线数据，然后退出登录。不可恢复。 */
export async function deleteAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  if (str(fd, "confirm").trim() !== DELETE_CONFIRM_TEXT) return { error: `请输入“${DELETE_CONFIRM_TEXT}”以确认` };
  try {
    await getServices().account.deleteAccount(user.id);
  } catch (e) {
    return { error: toMessage(e) };
  }
  await clearSessionCookie();
  redirect("/login");
}
