"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/app/actions/shared";
import { Field, FormMessage, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { DATA_KIND_HINT, DATA_KIND_LABEL } from "@/domain/imports";
import { PLATFORM_LABEL } from "@/domain/people";

export function ScreenshotBatchForm({ action }: { action: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, {});
  const [kind, setKind] = useState<keyof typeof DATA_KIND_LABEL>("CONTINUOUS");
  return (
    <form action={formAction} className="space-y-4">
      <Field label="聊天来自" htmlFor="platform">
        <Select id="platform" name="platform" defaultValue="WECHAT">
          {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">这批资料是</legend>
        {(Object.keys(DATA_KIND_LABEL) as (keyof typeof DATA_KIND_LABEL)[]).map((k) => (
          <label key={k} className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 has-[:checked]:border-primary">
            <input type="radio" name="dataKind" value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1" />
            <span>
              <span className="block text-sm font-medium">{DATA_KIND_LABEL[k]}</span>
              <span className="block text-xs text-muted-foreground">{DATA_KIND_HINT[k]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormMessage error={state.error} />
      <SubmitButton size="lg" className="w-full">
        下一步：上传截图
      </SubmitButton>
      <p className="text-xs text-muted-foreground">下一步只上传截图，不会识别、也不消耗识别额度；你点“开始识别”才会提交。</p>
    </form>
  );
}
