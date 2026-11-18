"use client";

import { useActionState } from "react";
import { deleteAccountAction } from "@/app/actions/account";
import { Field, FormMessage, Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { DELETE_CONFIRM_TEXT } from "@/domain/account";

/** 账户删除：必须输入确认文字。提交后立即停用并删除在线数据，退出登录。 */
export function DeleteAccountForm() {
  const [state, formAction] = useActionState(deleteAccountAction, {});
  return (
    <form action={formAction} className="space-y-3" data-testid="delete-account-form">
      <Field label={`请输入“${DELETE_CONFIRM_TEXT}”以确认`} htmlFor="delete-confirm">
        <Input id="delete-confirm" name="confirm" autoComplete="off" required />
      </Field>
      <FormMessage error={state.error} />
      <SubmitButton variant="outline" className="border-red-300 text-red-700" pendingText="正在删除…">
        永久删除我的账户
      </SubmitButton>
    </form>
  );
}
