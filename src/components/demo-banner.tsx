import { FlaskConical } from "lucide-react";

/** 演示状态标识：仅 APP_MODE=demo 且非生产环境时显示。 */
export function DemoBanner() {
  return (
    <div
      role="status"
      data-testid="demo-banner"
      className="flex items-center justify-center gap-2 bg-warn px-3 py-1.5 text-xs font-medium text-warn-foreground"
    >
      <FlaskConical className="size-3.5" aria-hidden />
      演示模式：模拟短信、模拟模型、本地存储，数据不代表真实服务
    </div>
  );
}
