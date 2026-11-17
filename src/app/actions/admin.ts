"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireAdmin } from "@/server/session";
import { str, toMessage, type FormState } from "./shared";

export async function createInviteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  try {
    await getServices().admin.createInvite(admin.id, {
      maxUses: Number(str(fd, "maxUses")),
      validDays: Number(str(fd, "validDays")),
      note: str(fd, "note"),
    });
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/admin");
  return { ok: true };
}

export async function revokeInviteAction(inviteId: string) {
  const admin = await requireAdmin();
  await getServices().admin.revokeInvite(admin.id, inviteId);
  revalidatePath("/admin");
}

export async function setUserStatusAction(userId: string, status: "ACTIVE" | "SUSPENDED") {
  const admin = await requireAdmin();
  await getServices().admin.setUserStatus(admin.id, userId, status);
  revalidatePath("/admin/users");
}

export async function grantQuotaAction(userId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  try {
    await getServices().admin.grantQuota(
      admin.id,
      userId,
      str(fd, "kind") as "SCREENSHOT" | "ANALYSIS",
      Number(str(fd, "amount")),
      str(fd, "reason").trim() || "管理员补发",
    );
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}
