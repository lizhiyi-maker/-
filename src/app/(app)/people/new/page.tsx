import Link from "next/link";
import { createPersonAction } from "@/app/actions/people";
import { PersonForm } from "@/components/person-form";

export default function NewPersonPage() {
  return (
    <section className="mx-auto max-w-xl">
      <Link href="/" className="text-sm text-muted-foreground">
        ← 返回对象列表
      </Link>
      <h1 className="mt-2 text-xl font-semibold">新建对象</h1>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">只需填写昵称或代号，其余信息之后随时补充。</p>
      <PersonForm action={createPersonAction} submitLabel="创建对象" />
    </section>
  );
}
