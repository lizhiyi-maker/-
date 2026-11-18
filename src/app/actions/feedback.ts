"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireAdmin, requireUser } from "@/server/session";
import type { FeedbackInput } from "@/domain/feedback";
import { str, toMessage, type FormState } from "./shared";

export async function submitFeedbackAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await getServices().feedback.submit(user.id, { category: str(fd, "category"), message: str(fd, "message"), snippet: str(fd, "snippet") } as FeedbackInput);
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/me/feedback");
  return { ok: true };
}

export async function handleFeedbackAction(feedbackId: string) {
  const admin = await requireAdmin();
  await getServices().admin.handleFeedback(admin.id, feedbackId);
  revalidatePath("/admin/feedback");
}
