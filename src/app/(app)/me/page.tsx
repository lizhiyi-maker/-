import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { DeleteAccountForm } from "@/components/delete-account-form";
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

      <Card data-testid="data-card">
        <CardTitle>我的数据</CardTitle>
        <p className="mb-3 text-xs text-muted-foreground">
          下载你保存在这里的全部结构化资料（对象、聊天消息及修订、线下事件、分析报告、偏好、额度记录），格式为 JSON。不包含手机号、登录凭证和已清理的截图原图。
        </p>
        <a href="/api/export" download className="inline-flex h-10 items-center rounded-md border bg-card px-4 text-sm font-medium" data-testid="export-link">
          下载我的全部资料（JSON）
        </a>
        <p className="mt-2 text-xs text-muted-foreground">单个对象的可读聊天文本，可在该对象的“聊天资料”页下载。</p>
      </Card>

      <form action={logoutAction}>
        <Button type="submit" variant="outline" className="w-full">
          退出登录
        </Button>
      </form>

      <Card className="border-red-200" data-testid="delete-account-card">
        <CardTitle>删除账户</CardTitle>
        <p className="mb-2 text-sm">删除后会<strong>立即退出登录并停用账户</strong>，并删除你在本产品里的全部在线数据：对象、聊天消息与修订、线下事件、分析报告、偏好、额度记录和上传的截图文件。<strong>无法恢复</strong>，建议先下载上面的数据。</p>
        <p className="mb-3 text-xs text-muted-foreground">
          这只涉及我们自己系统里的在线数据。系统备份、对象存储的历史版本，以及 AI 服务商那一侧的留存条件我们尚未核实，不对它们的删除作任何承诺。
        </p>
        <DeleteAccountForm />
      </Card>
    </section>
  );
}
