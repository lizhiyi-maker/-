"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/app/actions/shared";
import { Field, FormMessage, Select, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { DATA_KIND_HINT, DATA_KIND_LABEL } from "@/domain/imports";
import { PLATFORM_LABEL } from "@/domain/people";

export function ImportTextForm({
  action,
  maxChars,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  maxChars: number;
}) {
  const [state, formAction] = useActionState(action, {});
  const [text, setText] = useState("");
  const [kind, setKind] = useState<keyof typeof DATA_KIND_LABEL>("CONTINUOUS");
  const over = text.length > maxChars;

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

      <Field
        label="粘贴聊天文本"
        htmlFor="text"
        hint={`支持“发言人 时间”换行接内容，或“[日期 时间] 发言人：内容”两种格式。单批最多 ${maxChars} 字，更长请分批导入。`}
      >
        <Textarea
          id="text"
          name="text"
          rows={12}
          className="font-mono text-sm"
          placeholder={"阿青：在吗\n我：在\n阿青：周六有空吗"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className={over ? "text-xs text-red-600" : "text-xs text-muted-foreground"} data-testid="char-count">
          {text.length} / {maxChars} 字
        </p>
      </Field>

      <FormMessage error={state.error} />
      <SubmitButton size="lg" className="w-full" disabled={over || text.trim() === ""} pendingText="正在整理…">
        整理并进入确认
      </SubmitButton>
      <p className="text-xs text-muted-foreground">
        提交后不会自动分析。你会先确认“我/对方”、处理不确定的内容，再保存。粘贴文本不消耗截图识别额度。
      </p>
    </form>
  );
}
