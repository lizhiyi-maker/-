import Link from "next/link";
import { notFound } from "next/navigation";
import { updatePersonAction } from "@/app/actions/people";
import { PersonForm } from "@/components/person-form";
import { NotFoundError } from "@/server/people/service";
import { getServices } from "@/server/container";
import { requireUser } from "@/server/session";

export default async function EditPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const person = await getServices()
    .people.get(user.id, id)
    .catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!person) notFound();
  return (
    <section className="mx-auto max-w-xl">
      <Link href={`/people/${id}`} className="text-sm text-muted-foreground">
        ← 返回
      </Link>
      <h1 className="mb-4 mt-2 text-xl font-semibold">编辑对象</h1>
      <PersonForm action={updatePersonAction.bind(null, id)} defaults={person} submitLabel="保存" />
    </section>
  );
}
