"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import type { EventFormState } from "@/app/actions/events";
import { Field, FormMessage, Input, Select, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { EVENT_KIND_LABEL, EVENT_LIMITS } from "@/domain/events";

export interface EventFormValues {
  kind: string;
  occurredOn: string;
  facts: string;
  personalNote: string;
}

/**
 * 线下事件表单。事实与个人感受是两个独立的输入：事实会作为分析资料（发送给 AI 服务商、可被报告引用），
 * 个人感受只留在本产品里。出错时保留用户填写的内容。
 */
export function EventForm({
  action,
  initial,
  maxDate,
  submitLabel,
  cancelHref,
}: {
  action: (prev: EventFormState, fd: FormData) => Promise<EventFormState>;
  initial: EventFormValues;
  /** 事件日期的上限（北京时间的今天） */
  maxDate: string;
  submitLabel: string;
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);
  const uid = useId(); // 新增与修改表单可能同时在页面上，id 不能重复（否则标签会指向第一个表单的输入）
  const v = state.values ?? initial;
  // 新增成功后清空（编辑成功会跳转离开）
  useEffect(() => {
    if (state.ok && !cancelHref) ref.current?.reset();
  }, [state, cancelHref]);

  return (
    <form ref={ref} action={formAction} className="space-y-3" data-testid="event-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="事件类型" htmlFor={`${uid}-kind`}>
          <Select id={`${uid}-kind`} name="kind" defaultValue={v.kind}>
            {Object.entries(EVENT_KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="发生日期" htmlFor={`${uid}-date`}>
          <Input id={`${uid}-date`} name="occurredOn" type="date" required max={maxDate} defaultValue={v.occurredOn} />
        </Field>
      </div>
      <Field label="发生了什么（只写事实）" htmlFor={`${uid}-facts`} hint="例如时间、地点、做了什么、说了什么。这部分会作为分析资料发送给 AI 服务商，并可能被报告引用为证据。">
        <Textarea id={`${uid}-facts`} name="facts" required maxLength={EVENT_LIMITS.facts} defaultValue={v.facts} />
      </Field>
      <Field label="我的感受（选填）" htmlFor={`${uid}-note`} hint="只留在本产品里：不会发送给 AI 服务商，也不会被当作对方的客观事实或分析证据。">
        <Textarea id={`${uid}-note`} name="personalNote" maxLength={EVENT_LIMITS.note} defaultValue={v.personalNote} className="min-h-16" />
      </Field>
      <FormMessage error={state.error} ok={state.ok} okText="已记录" />
      <div className="flex items-center gap-3">
        <SubmitButton>{submitLabel}</SubmitButton>
        {cancelHref && (
          <Link href={cancelHref} className="text-sm text-muted-foreground">
            取消
          </Link>
        )}
      </div>
    </form>
  );
}
