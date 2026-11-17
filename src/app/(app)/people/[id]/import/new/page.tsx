import Link from "next/link";
import { notFound } from "next/navigation";
import { submitTextImportAction } from "@/app/actions/imports";
import { ImportTextForm } from "@/components/import-text-form";
import { NotFoundError } from "@/server/errors";
import { getServices } from "@/server/container";
import { quotaConfig } from "@/server/quota/config";
import { requireUser } from "@/server/session";

export default async function NewImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const person = await getServices()
    .people.get(user.id, id)
    .catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!person) notFound();
  return (
    <section className="mx-auto max-w-xl">
      <Link href={`/people/${id}?tab=chats`} className="text-sm text-muted-foreground">
        ← 返回“{person.nickname}”的聊天资料
      </Link>
      <h1 className="mb-1 mt-2 text-xl font-semibold">导入聊天资料</h1>
      <p className="mb-4 text-sm text-muted-foreground">截图导入将在下一阶段开放，目前支持粘贴文本。</p>
      <ImportTextForm action={submitTextImportAction.bind(null, id)} maxChars={quotaConfig.textPerBatchChars} />
    </section>
  );
}
