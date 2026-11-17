"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";
import { toMessage, type FormState } from "./shared";

/** 记录用户对“AI 服务说明”的同意（按文案版本与服务商）。 */
export async function acceptConsentAction(): Promise<void> {
  const user = await requireUser();
  await getServices().consent.accept(user.id);
  revalidatePath("/", "layout");
}

/** 用户点击“开始分析”才提交；新增资料不会自动触发。 */
export async function startAnalysisAction(personId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await getServices().analysis.start(user.id, personId);
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath(`/people/${personId}`);
  revalidatePath("/");
  return { ok: true };
}
