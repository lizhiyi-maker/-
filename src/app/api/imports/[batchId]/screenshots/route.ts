import { NextResponse } from "next/server";
import { getServices } from "@/server/container";
import { isDomainError } from "@/server/errors";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * 上传一张截图（每个请求一个文件：每张独立成功/失败/重试，进度由服务端记录）。
 * 响应只包含状态与提示，不回显文件内容。
 */
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { batchId } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "上传内容无效" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "没有收到文件" }, { status: 400 });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await getServices().recognition.addScreenshot(user.id, batchId, { name: file.name, bytes });
    return NextResponse.json(r.status === "added" ? { status: "added" } : { status: "duplicate" }, { status: 200 });
  } catch (e) {
    if (isDomainError(e, "NotFoundError")) return NextResponse.json({ error: "导入批次不存在" }, { status: 404 });
    if (isDomainError(e, "ValidationError")) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[upload]", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}
