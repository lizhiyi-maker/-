import { getServices } from "@/server/container";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 下载本人的全部结构化资料（JSON）。要求已登录，只含本人数据；响应不被缓存。 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const bundle = await getServices().exporter.build(user.id);
  const day = bundle.exportedAt.toISOString().slice(0, 10);
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="relationship-export-${day}.json"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
