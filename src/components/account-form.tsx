"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/shared";
import { FormMessage, Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { PLATFORM_LABEL } from "@/domain/people";

export function AddAccountForm({ action }: { action: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="mt-3 space-y-2">
      <div className="flex gap-2">
        <Select name="platform" aria-label="平台" className="w-28 shrink-0" defaultValue="WECHAT">
          {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Input name="handle" aria-label="账号或昵称" placeholder="该平台上的账号或昵称" required maxLength={80} />
      </div>
      <FormMessage error={state.error} />
      <SubmitButton variant="outline" size="sm">
        确认关联到此对象
      </SubmitButton>
    </form>
  );
}
