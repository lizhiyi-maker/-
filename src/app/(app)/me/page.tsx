import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { decryptPhone, maskPhone } from "@/server/auth/phone";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

export default async function MePage() {
  const user = await requireUser();
  const { db, keys, quota, preferences } = getServices();
  const [row, summary, prefs] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { phoneEnc: true } }),
    quota.getSummary(user.id),
    preferences.get(user.id),
  ]);
  const phone = maskPhone(decryptPhone(row.phoneEnc, keys.encKey));

  return (
    <section className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">我的</h1>

      <Card>
        <CardTitle>账户</CardTitle>
        <p className="text-sm" data-testid="phone-masked">
          手机号：{phone}
        </p>
      </Card>

      <Card data-testid="quota-card">
        <CardTitle>我的额度</CardTitle>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">截图识别（张）</dt>
            <dd className="text-2xl font-semibold" data-testid="quota-screenshot">
              {summary.SCREENSHOT}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">关系分析（次）</dt>
            <dd className="text-2xl font-semibold" data-testid="quota-analysis">
              {summary.ANALYSIS}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">本周期额度将于 {formatDate(summary.resetsAt)} 重置；额度不足时请联系管理员补发。</p>
      </Card>

      <Link href="/me/preferences" className="flex items-center justify-between rounded-lg border bg-card p-4 text-sm">
        <span>
          个人偏好
          <span className="ml-2 text-xs text-muted-foreground">{prefs.isDefault ? "使用默认配置" : `已自定义（版本 ${prefs.version}）`}</span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>

      {user.role === "ADMIN" && (
        <Link href="/admin" className="flex items-center justify-between rounded-lg border bg-card p-4 text-sm">
          管理后台
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </Link>
      )}

      <form action={logoutAction}>
        <Button type="submit" variant="outline" className="w-full">
          退出登录
        </Button>
      </form>
    </section>
  );
}
