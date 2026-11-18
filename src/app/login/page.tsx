import { redirect } from "next/navigation";
import { devLoginAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Mascot } from "@/components/theme/mascot";
import { devLoginAllowed, getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const showDevLogin = devLoginAllowed(getEnv());
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <div className="mb-3 flex justify-center md:justify-start" data-testid="login-mascot">
        <Mascot size={96} />
      </div>
      <h1 className="text-2xl font-semibold">关系工作台</h1>
      <p className="mt-1 text-sm text-muted-foreground">邀请制内测 · 手机号验证码登录</p>
      <div className="mt-8">
        <LoginForm />
      </div>
      {showDevLogin && (
        <div className="mt-10 space-y-2 border-t pt-6" data-testid="dev-login">
          <p className="text-xs text-muted-foreground">开发登录（仅演示模式，生产环境不可用）</p>
          <div className="flex gap-2">
            <form action={devLoginAction.bind(null, "user")} className="flex-1">
              <Button type="submit" variant="outline" className="w-full">
                演示用户登录
              </Button>
            </form>
            <form action={devLoginAction.bind(null, "admin")} className="flex-1">
              <Button type="submit" variant="outline" className="w-full">
                演示管理员登录
              </Button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
