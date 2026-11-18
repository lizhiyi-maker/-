import { getServices } from "@/server/container";
import { isNotFound } from "@/server/errors";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 下载某个对象已保存的聊天文本（可读格式）。未登录 401；不属于本人的对象与不存在的表现一致（404）。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const { id } = await params;
  try {
    const { nickname, text } = await getServices().exporter.chatText(user.id, id);
    return new Response(text, {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/plain; charset=utf-8",
        // 昵称可能含中文：用 RFC 5987 的 filename*，并给出 ASCII 回退名
        "Content-Disposition": `attachment; filename="chat.txt"; filename*=UTF-8''${encodeURIComponent(`${nickname}-聊天文本.txt`)}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (isNotFound(e)) return new Response("Not Found", { status: 404, headers: NO_STORE });
    throw e;
  }
}
