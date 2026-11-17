"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";
import { str, toMessage, type FormState } from "./shared";

const importUrl = (personId: string, batchId: string, query = "") => `/people/${personId}/import/${batchId}${query}`;

/** 新建批次并提交粘贴的文本，成功后进入确认页。批次创建后若文本无效，批次保留为“待提交”，不占用额度。 */
export async function submitTextImportAction(personId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { imports } = getServices();
  let batchId: string;
  try {
    const batch = await imports.createBatch(user.id, personId, {
      platform: str(fd, "platform") as "WECHAT" | "DOUYIN" | "OTHER",
      dataKind: str(fd, "dataKind") as "CONTINUOUS" | "CURATED" | "UNCERTAIN",
    });
    batchId = batch.id;
    await imports.submitText(user.id, batchId, str(fd, "text"));
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/");
  redirect(importUrl(personId, batchId));
}

export async function setLabelRoleAction(personId: string, batchId: string, label: string, role: "SELF" | "OTHER") {
  const user = await requireUser();
  await getServices().imports.setLabelRole(user.id, batchId, label, role);
  revalidatePath(importUrl(personId, batchId));
}

export async function confirmIdentityAction(personId: string, batchId: string) {
  const user = await requireUser();
  await getServices().imports.confirmIdentity(user.id, batchId);
  revalidatePath(importUrl(personId, batchId));
}

export async function swapSpeakersAction(personId: string, batchId: string) {
  const user = await requireUser();
  const r = await getServices().imports.swapSpeakers(user.id, batchId);
  redirect(importUrl(personId, batchId, `?swapped=${r.swappedMessages}&overlap=${r.overlapBefore}-${r.overlapAfter}`));
}

export async function editMessageAction(personId: string, batchId: string, messageId: string, fd: FormData) {
  const user = await requireUser();
  const content = str(fd, "content");
  const speaker = str(fd, "speaker");
  await getServices().imports.editMessage(user.id, messageId, {
    ...(content ? { content } : {}),
    ...(speaker ? { speaker: speaker as "SELF" | "OTHER" | "UNKNOWN" } : {}),
  });
  revalidatePath(importUrl(personId, batchId));
}

export async function setSpeakerAction(personId: string, batchId: string, messageId: string, speaker: "SELF" | "OTHER") {
  const user = await requireUser();
  await getServices().imports.editMessage(user.id, messageId, { speaker });
  revalidatePath(importUrl(personId, batchId));
}

export async function acceptMessageAction(personId: string, batchId: string, messageId: string) {
  const user = await requireUser();
  await getServices().imports.acceptMessage(user.id, messageId);
  revalidatePath(importUrl(personId, batchId));
}

export async function discardMessageAction(personId: string, batchId: string, messageId: string) {
  const user = await requireUser();
  await getServices().imports.discardMessage(user.id, messageId);
  revalidatePath(importUrl(personId, batchId));
}

export async function setDataKindAction(personId: string, batchId: string, fd: FormData) {
  const user = await requireUser();
  await getServices().imports.setDataKind(user.id, batchId, str(fd, "dataKind") as "CONTINUOUS" | "CURATED" | "UNCERTAIN");
  revalidatePath(importUrl(personId, batchId));
  revalidatePath(`/people/${personId}`);
}

export async function confirmBatchAction(personId: string, batchId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  let r: { saved: number; merged: number };
  try {
    r = await getServices().imports.confirm(user.id, batchId, { keepOverlap: str(fd, "overlap") === "keep" });
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/");
  redirect(`/people/${personId}?tab=chats&saved=${r.saved}&merged=${r.merged}`);
}

export async function deleteBatchAction(personId: string, batchId: string, redirectTo: "person" | "stay") {
  const user = await requireUser();
  await getServices().imports.deleteBatch(user.id, batchId);
  revalidatePath("/");
  redirect(redirectTo === "person" ? `/people/${personId}?tab=chats` : "/");
}
