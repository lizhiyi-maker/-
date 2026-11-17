"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, Input } from "@/components/ui/form-controls";

export function LoginForm() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [sent, setSent] = useState(false);
  const [needInvite, setNeedInvite] = useState(false);
  const [error, setError] = useState<string>();
  const [demoCode, setDemoCode] = useState<string>();
  const [cooldown, setCooldown] = useState(0);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function sendCode() {
    setError(undefined);
    start(async () => {
      const r = await requestCodeAction(phone);
      if (r.ok) {
        setSent(true);
        setDemoCode(r.demoCode);
      } else {
        setError(r.error);
      }
      if (r.retryAfterSec) setCooldown(r.retryAfterSec);
    });
  }

  function verify() {
    setError(undefined);
    start(async () => {
      const r = await verifyCodeAction({ phone, code, inviteCode: invite || undefined });
      if (r.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      if (r.needInvite) setNeedInvite(true);
      setError(r.error);
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (sent) verify();
        else sendCode();
      }}
    >
      <Field label="手机号" htmlFor="phone" hint="仅支持中国大陆手机号，年满 18 周岁方可使用">
        <Input
          id="phone"
          name="phone"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="请输入 11 位手机号"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={sent}
        />
      </Field>

      {sent && (
        <>
          <Field label="验证码" htmlFor="code" hint="验证码 5 分钟内有效">
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          {demoCode && (
            <p data-testid="demo-code" className="rounded-md bg-warn/40 px-3 py-2 text-sm text-warn-foreground">
              演示模式：验证码为 <strong>{demoCode}</strong>
            </p>
          )}
          <Field label={needInvite ? "邀请码（新用户必填）" : "邀请码（新用户需要）"} htmlFor="invite">
            <Input id="invite" name="invite" autoCapitalize="characters" value={invite} onChange={(e) => setInvite(e.target.value)} />
          </Field>
        </>
      )}

      <FormMessage error={error} />

      <Button type="submit" size="lg" className="w-full" disabled={pending || !phone || (sent && !code)}>
        {pending ? "处理中…" : sent ? "登录" : "获取验证码"}
      </Button>

      {sent && (
        <Button type="button" variant="ghost" className="w-full" disabled={pending || cooldown > 0} onClick={sendCode}>
          {cooldown > 0 ? `${cooldown} 秒后可重新获取` : "重新获取验证码"}
        </Button>
      )}
    </form>
  );
}
