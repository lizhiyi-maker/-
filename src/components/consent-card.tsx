import { acceptConsentAction } from "@/app/actions/analysis";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { consentSections, type ProviderInfo } from "@/domain/consent";

/** 首次向 AI 服务商发送内容（截图识别或关系分析）之前展示：发给谁、发送什么、用途，以及留存条件待核实。 */
export function ConsentCard({ provider, action }: { provider: ProviderInfo; action: string }) {
  return (
    <Card className="border-primary" data-testid="consent-card">
      <CardTitle>AI 服务说明</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">在使用{action}之前，请先了解你的内容会如何被处理。</p>
      <dl className="space-y-3 text-sm">
        {consentSections(provider).map((s) => (
          <div key={s.heading}>
            <dt className="font-medium">{s.heading}</dt>
            <dd className="mt-0.5 text-muted-foreground">{s.body}</dd>
          </div>
        ))}
      </dl>
      <form action={acceptConsentAction} className="mt-4">
        <Button type="submit" size="lg" className="w-full">
          我已阅读并同意
        </Button>
      </form>
    </Card>
  );
}
