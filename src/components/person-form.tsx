"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/shared";
import { FormMessage, Field, Input, Select, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { GENDER_LABEL, STAGE_LABEL } from "@/domain/people";

export interface PersonDefaults {
  nickname?: string;
  gender?: string | null;
  channel?: string | null;
  metAtApprox?: string | null;
  stage?: string | null;
  hasMet?: boolean | null;
  seesAsAmbiguous?: boolean | null;
  feelingsNote?: string | null;
  expectationsNote?: string | null;
}

const tri = (v: boolean | null | undefined) => (v === true ? "yes" : v === false ? "no" : "");

export function PersonForm({
  action,
  defaults = {},
  submitLabel,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  defaults?: PersonDefaults;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <Field label="昵称或代号" htmlFor="nickname" hint="唯一必填项，仅你自己可见">
        <Input id="nickname" name="nickname" required maxLength={40} defaultValue={defaults.nickname ?? ""} />
      </Field>

      <details className="rounded-lg border bg-card p-4" open={Boolean(defaults.nickname)}>
        <summary className="cursor-pointer text-sm font-medium">更多信息（选填）</summary>
        <div className="mt-4 space-y-4">
          <Field label="性别" htmlFor="gender">
            <Select id="gender" name="gender" defaultValue={defaults.gender ?? ""}>
              <option value="">未填写</option>
              {Object.entries(GENDER_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="认识渠道" htmlFor="channel">
            <Input id="channel" name="channel" maxLength={60} placeholder="例如：朋友介绍、同事、线上" defaultValue={defaults.channel ?? ""} />
          </Field>
          <Field label="大概认识时间" htmlFor="metAtApprox">
            <Input id="metAtApprox" name="metAtApprox" maxLength={40} placeholder="例如：2026 年 9 月" defaultValue={defaults.metAtApprox ?? ""} />
          </Field>
          <Field label="关系阶段" htmlFor="stage" hint="由你确认；系统只会提出建议，不会自动改变">
            <Select id="stage" name="stage" defaultValue={defaults.stage ?? ""}>
              <option value="">未填写</option>
              {Object.entries(STAGE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="是否见过面" htmlFor="hasMet" hint="见面经历单独记录，不属于关系阶段">
            <Select id="hasMet" name="hasMet" defaultValue={tri(defaults.hasMet)}>
              <option value="">未填写</option>
              <option value="yes">见过</option>
              <option value="no">没见过</option>
            </Select>
          </Field>
          <Field label="你是否认为处于暧昧中" htmlFor="seesAsAmbiguous" hint="这是你的主观判断，单独记录">
            <Select id="seesAsAmbiguous" name="seesAsAmbiguous" defaultValue={tri(defaults.seesAsAmbiguous)}>
              <option value="">未填写</option>
              <option value="yes">是</option>
              <option value="no">否</option>
            </Select>
          </Field>
          <Field label="个人感受" htmlFor="feelingsNote" hint="你的主观记录，不会被当作对方的客观事实">
            <Textarea id="feelingsNote" name="feelingsNote" maxLength={2000} defaultValue={defaults.feelingsNote ?? ""} />
          </Field>
          <Field label="我的期待" htmlFor="expectationsNote">
            <Textarea id="expectationsNote" name="expectationsNote" maxLength={2000} defaultValue={defaults.expectationsNote ?? ""} />
          </Field>
        </div>
      </details>

      <FormMessage error={state.error} />
      <SubmitButton size="lg" className="w-full">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
