"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";
import type { PersonInput } from "@/domain/people";
import { feelingSchema } from "@/domain/people";
import { orNull, str, toMessage, triBool, type FormState } from "./shared";

function readPerson(fd: FormData): PersonInput {
  return {
    nickname: str(fd, "nickname"),
    gender: (orNull(fd, "gender") as PersonInput["gender"]) ?? null,
    channel: str(fd, "channel"),
    metAtApprox: str(fd, "metAtApprox"),
    stage: (orNull(fd, "stage") as PersonInput["stage"]) ?? null,
    hasMet: triBool(fd, "hasMet"),
    seesAsAmbiguous: triBool(fd, "seesAsAmbiguous"),
    feelingsNote: str(fd, "feelingsNote"),
    expectationsNote: str(fd, "expectationsNote"),
  };
}

export async function createPersonAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    id = (await getServices().people.create(user.id, readPerson(fd))).id;
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/");
  redirect(`/people/${id}`);
}

export async function updatePersonAction(personId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await getServices().people.update(user.id, personId, readPerson(fd));
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath("/");
  redirect(`/people/${personId}`);
}

export async function deletePersonAction(personId: string) {
  const user = await requireUser();
  await getServices().people.remove(user.id, personId);
  revalidatePath("/");
  redirect("/");
}

export async function setFeelingAction(personId: string, value: string) {
  const user = await requireUser();
  await getServices().people.setFeeling(user.id, personId, feelingSchema.parse(value));
  revalidatePath(`/people/${personId}`);
}

export async function addAccountAction(personId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await getServices().people.addAccount(user.id, personId, {
      platform: str(fd, "platform") as "WECHAT" | "DOUYIN" | "OTHER",
      handle: str(fd, "handle"),
    });
  } catch (e) {
    return { error: toMessage(e) };
  }
  revalidatePath(`/people/${personId}`);
  return { ok: true };
}

export async function removeAccountAction(personId: string, accountId: string) {
  const user = await requireUser();
  await getServices().people.removeAccount(user.id, personId, accountId);
  revalidatePath(`/people/${personId}`);
}
