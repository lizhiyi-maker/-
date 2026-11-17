"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/shared";
import { FormMessage } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function ConfirmImportForm({
  action,
  canConfirm,
  blockers,
  overlapCount,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  canConfirm: boolean;
  blockers: string[];
  overlapCount: number;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      {overlapCount > 0 && (
        <fieldset className="space-y-2 rounded-lg border border-warn bg-warn/10 p-3">
          <legend className="px-1 text-sm font-medium">有 {overlapCount} 条消息与已保存的聊天重复</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="overlap" value="merge" defaultChecked className="mt-1" />
            <span>合并（推荐）：只保存新增的消息，避免同一段聊天被重复累计</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="overlap" value="keep" className="mt-1" />
            <span>全部保留：这些消息确实是新发生的（例如对方真的又发了一遍相同的话）</span>
          </label>
        </fieldset>
      )}
      {!canConfirm && blockers.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="blockers">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <FormMessage error={state.error} />
      <SubmitButton size="lg" className="w-full" disabled={!canConfirm} pendingText="正在保存…">
        确认保存
      </SubmitButton>
      <p className="text-xs text-muted-foreground">保存后，这些消息成为正式的聊天资料。之后仍可修改文字，修改会保留历史修订。</p>
    </form>
  );
}
