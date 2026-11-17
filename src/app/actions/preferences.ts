"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";
import { DIMENSIONS } from "@/domain/preferences";
import { orNull, str, toMessage, type FormState } from "./shared";

export async function savePreferencesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await getServices().preferences.save(user.id, {
      expectation: orNull(fd, "expectation") as never,
      contactFrequency: orNull(fd, "contactFrequency") as never,
      pace: orNull(fd, "pace") as never,
      importance: Object.fromEntries(DIMENSIONS.map((d) => [d.key, Number(str(fd, `imp_${d.key}`))])),
    });
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/me");
  revalidatePath("/me/preferences");
  return { ok: true };
}

export async function resetPreferencesAction(): Promise<void> {
  const user = await requireUser();
  await getServices().preferences.reset(user.id);
  revalidatePath("/me");
  revalidatePath("/me/preferences");
}
