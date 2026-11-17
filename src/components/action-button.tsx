"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/shared";
import { FormMessage } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ButtonProps } from "@/components/ui/button";

/** 触发一个服务端操作的按钮，并显示失败原因（例如额度不足）。 */
export function ActionButton({
  action,
  children,
  pendingText,
  ...props
}: ButtonProps & { action: (prev: FormState) => Promise<FormState>; pendingText?: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton pendingText={pendingText} {...props}>
        {children}
      </SubmitButton>
      <FormMessage error={state.error} />
    </form>
  );
}
