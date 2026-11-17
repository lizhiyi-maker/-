import Link from "next/link";
import { notFound } from "next/navigation";
import { createScreenshotBatchAction, submitTextImportAction } from "@/app/actions/imports";
import { ImportTextForm } from "@/components/import-text-form";
import { ScreenshotBatchForm } from "@/components/screenshot-batch-form";
import { cn } from "@/lib/utils";
import { isNotFound } from "@/server/errors";
import { getServices } from "@/server/container";
import { quotaConfig } from "@/server/quota/config";
import { requireUser } from "@/server/session";

export default async function NewImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { id } = await params;
  const { mode } = await searchParams;
  const screenshot = mode === "screenshot";
  const user = await requireUser();
  const person = await getServices()
    .people.get(user.id, id)
    .catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
  if (!person) notFound();

  const tabs = [
    { key: "text", label: "粘贴文本", href: `/people/${id}/import/new` },
    { key: "screenshot", label: "上传截图", href: `/people/${id}/import/new?mode=screenshot` },
  ];
  return (
    <section className="mx-auto max-w-xl">
      <Link href={`/people/${id}?tab=chats`} className="text-sm text-muted-foreground">
        ← 返回“{person.nickname}”的聊天资料
      </Link>
      <h1 className="mb-3 mt-2 text-xl font-semibold">导入聊天资料</h1>
      <nav aria-label="导入方式" className="mb-4 flex gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={(t.key === "screenshot") === screenshot ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2 text-sm",
              (t.key === "screenshot") === screenshot ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {screenshot ? (
        <ScreenshotBatchForm action={createScreenshotBatchAction.bind(null, id)} />
      ) : (
        <ImportTextForm action={submitTextImportAction.bind(null, id)} maxChars={quotaConfig.textPerBatchChars} />
      )}
    </section>
  );
}
