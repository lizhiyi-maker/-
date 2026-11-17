import Link from "next/link";
import { resetPreferencesAction, savePreferencesAction } from "@/app/actions/preferences";
import { PreferencesForm } from "@/components/preferences-form";
import { Badge } from "@/components/ui/card";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

export default async function PreferencesPage() {
  const user = await requireUser();
  const prefs = await getServices().preferences.get(user.id);
  return (
    <section className="mx-auto max-w-xl space-y-4">
      <Link href="/me" className="text-sm text-muted-foreground">
        ← 返回我的
      </Link>
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">个人偏好</h1>
        <Badge tone={prefs.isDefault ? "muted" : "primary"}>{prefs.isDefault ? "使用默认配置" : `已自定义 · 版本 ${prefs.version}`}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">偏好对你所有的对象统一生效，可以跳过并使用默认配置。</p>
      <PreferencesForm action={savePreferencesAction} onReset={resetPreferencesAction} canReset={!prefs.isDefault} values={prefs} />
    </section>
  );
}
