"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";
import type { EventInput } from "@/domain/events";
import { str, toMessage, type FormState } from "./shared";

/** 出错时带回用户填写的内容，表单据此恢复（React 在 action 结束后会重置未受控的输入）。 */
export interface EventFormState extends FormState {
  values?: { kind: string; occurredOn: string; facts: string; personalNote: string };
}

function readEvent(fd: FormData) {
  return { kind: str(fd, "kind"), occurredOn: str(fd, "occurredOn"), facts: str(fd, "facts"), personalNote: str(fd, "personalNote") };
}

export async function createEventAction(personId: string, _prev: EventFormState, fd: FormData): Promise<EventFormState> {
  const user = await requireUser();
  const values = readEvent(fd);
  try {
    await getServices().events.create(user.id, personId, values as EventInput);
  } catch (e) {
    return { error: toMessage(e), values };
  }
  revalidatePath(`/people/${personId}`);
  revalidatePath("/");
  return { ok: true };
}

export async function updateEventAction(personId: string, eventId: string, _prev: EventFormState, fd: FormData): Promise<EventFormState> {
  const user = await requireUser();
  const values = readEvent(fd);
  try {
    await getServices().events.update(user.id, eventId, values as EventInput);
  } catch (e) {
    return { error: toMessage(e), values };
  }
  revalidatePath(`/people/${personId}`);
  revalidatePath("/");
  redirect(`/people/${personId}?tab=records`);
}

export async function deleteEventAction(personId: string, eventId: string) {
  const user = await requireUser();
  await getServices().events.remove(user.id, eventId);
  revalidatePath(`/people/${personId}`);
  revalidatePath("/");
}
