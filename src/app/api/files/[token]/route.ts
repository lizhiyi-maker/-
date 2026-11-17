import { getServices } from "@/server/container";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * 凭短时签名令牌查看本人的原图。要求已登录；令牌无效、过期、属于别人、原图已撤销（确认保存后）
 * 一律 404，不区分原因。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await getCurrentUser();
  if (!user) return notFound();
  const { token } = await params;
  try {
    const { bytes, contentType } = await getServices().recognition.open(user.id, token);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch {
    return notFound();
  }
}
