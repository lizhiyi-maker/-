"use client";

import { useActionState, useState, useTransition } from "react";
import type { FormState } from "@/app/actions/shared";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  CONTACT_FREQUENCY_LABEL,
  DEFAULT_PREFERENCES,
  DIMENSIONS,
  EXPECTATION_LABEL,
  IMPORTANCE,
  PACE_LABEL,
  type PreferenceValues,
} from "@/domain/preferences";

/** 档位说明只标注范围两端与默认值，数值本身来自评分配置（IMPORTANCE），不在此处硬编码。 */
function importanceText(n: number): string {
  if (n === IMPORTANCE.default) return `${n} · 默认`;
  if (n === IMPORTANCE.min) return `${n} · 最不重要`;
  if (n === IMPORTANCE.max) return `${n} · 最重要`;
  return String(n);
}

function Options({ labels }: { labels: Record<string, string> }) {
  return (
    <>
      <option value="">未设置</option>
      {Object.entries(labels).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </>
  );
}

export function PreferencesForm({
  action,
  onReset,
  canReset,
  values,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  onReset: () => Promise<void>;
  canReset: boolean;
  values: PreferenceValues;
}) {
  const [state, formAction] = useActionState(action, {});
  const [draft, setDraft] = useState<PreferenceValues>(values);
  const [resetting, startReset] = useTransition();
  const levels = Array.from({ length: IMPORTANCE.max - IMPORTANCE.min + 1 }, (_, i) => IMPORTANCE.min + i);
  const set = (patch: Partial<PreferenceValues>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form action={formAction} className="space-y-4">
      <Field label="当前关系期待" htmlFor="expectation">
        <Select id="expectation" name="expectation" value={draft.expectation ?? ""} onChange={(e) => set({ expectation: e.target.value || null })}>
          <Options labels={EXPECTATION_LABEL} />
        </Select>
      </Field>
      <Field label="联系频率偏好" htmlFor="contactFrequency">
        <Select
          id="contactFrequency"
          name="contactFrequency"
          value={draft.contactFrequency ?? ""}
          onChange={(e) => set({ contactFrequency: e.target.value || null })}
        >
          <Options labels={CONTACT_FREQUENCY_LABEL} />
        </Select>
      </Field>
      <Field label="推进节奏" htmlFor="pace">
        <Select id="pace" name="pace" value={draft.pace ?? ""} onChange={(e) => set({ pace: e.target.value || null })}>
          <Options labels={PACE_LABEL} />
        </Select>
      </Field>

      <fieldset className="space-y-3 rounded-lg border bg-card p-4">
        <legend className="px-1 text-sm font-medium">重视的维度</legend>
        <p className="text-xs text-muted-foreground">默认五个维度同等重要。调整后会按比例归一化；修改后，已有分析会被标记为“待更新”。</p>
        {DIMENSIONS.map((d) => (
          <Field key={d.key} label={d.label} htmlFor={`imp_${d.key}`}>
            <Select
              id={`imp_${d.key}`}
              name={`imp_${d.key}`}
              value={String(draft.importance[d.key] ?? IMPORTANCE.default)}
              onChange={(e) => set({ importance: { ...draft.importance, [d.key]: Number(e.target.value) } })}
            >
              {levels.map((n) => (
                <option key={n} value={n}>
                  {importanceText(n)}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </fieldset>

      <FormMessage error={state.error} ok={state.ok} okText="偏好已保存" />
      <SubmitButton size="lg" className="w-full">
        保存偏好
      </SubmitButton>
      {canReset && (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={resetting}
          onClick={() =>
            startReset(async () => {
              await onReset();
              setDraft(DEFAULT_PREFERENCES);
            })
          }
        >
          恢复默认配置
        </Button>
      )}
    </form>
  );
}
