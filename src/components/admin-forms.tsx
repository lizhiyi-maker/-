"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/shared";
import { FormMessage, Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function CreateInviteForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-[8rem_8rem_1fr_auto]">
      <Input name="maxUses" type="number" min={1} defaultValue={1} aria-label="可使用次数" />
      <Input name="validDays" type="number" min={1} defaultValue={14} aria-label="有效天数" />
      <Input name="note" placeholder="备注（选填）" aria-label="备注" maxLength={100} />
      <SubmitButton>生成邀请码</SubmitButton>
      <div className="sm:col-span-4">
        <FormMessage error={state.error} ok={state.ok} okText="邀请码已生成" />
      </div>
    </form>
  );
}

export function GrantQuotaForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <Select name="kind" aria-label="额度类型" className="w-36">
        <option value="SCREENSHOT">截图识别</option>
        <option value="ANALYSIS">关系分析</option>
      </Select>
      <Input name="amount" type="number" min={1} defaultValue={10} aria-label="补发数量" className="w-24" />
      <Input name="reason" placeholder="原因" aria-label="补发原因" className="w-40" maxLength={100} />
      <SubmitButton size="sm" variant="outline">
        补发
      </SubmitButton>
      <FormMessage error={state.error} ok={state.ok} okText="已补发" />
    </form>
  );
}
