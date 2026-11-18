"use client";

import { useActionState, useEffect, useRef } from "react";
import { submitFeedbackAction } from "@/app/actions/feedback";
import { Field, FormMessage, Select, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { FEEDBACK_CATEGORY_LABEL, FEEDBACK_LIMITS } from "@/domain/feedback";

/** 反馈表单。片段只有用户主动粘贴才会附上，系统不会自动带上任何聊天或对象信息。 */
export function FeedbackForm() {
  const [state, formAction] = useActionState(submitFeedbackAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={formAction} className="space-y-3" data-testid="feedback-form">
      <Field label="反馈类型" htmlFor="fb-category">
        <Select id="fb-category" name="category" defaultValue="BUG">
          {Object.entries(FEEDBACK_CATEGORY_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="想反馈的内容" htmlFor="fb-message">
        <Textarea id="fb-message" name="message" required maxLength={FEEDBACK_LIMITS.message} />
      </Field>
      <Field
        label="附上一段文字（选填）"
        htmlFor="fb-snippet"
        hint="如果想让我们看到具体是哪一句，可以自己粘贴在这里。系统不会自动附上你的聊天、对象或分析内容；管理员默认也看不到它们。请避免粘贴不需要的隐私信息。"
      >
        <Textarea id="fb-snippet" name="snippet" maxLength={FEEDBACK_LIMITS.snippet} className="min-h-16" />
      </Field>
      <FormMessage error={state.error} ok={state.ok} okText="已收到，谢谢你的反馈" />
      <SubmitButton pendingText="提交中…">提交反馈</SubmitButton>
    </form>
  );
}
