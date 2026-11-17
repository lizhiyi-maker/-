import { retryFailedAction, removeScreenshotAction, skipFailedAction, startRecognitionAction } from "@/app/actions/imports";
import { ActionButton } from "@/components/action-button";
import { ConsentCard } from "@/components/consent-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { ScreenshotUploader } from "@/components/screenshot-uploader";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle } from "@/components/ui/card";
import type { ProviderInfo } from "@/domain/consent";

export interface ShotView {
  id: string;
  idx: number;
  status: "UPLOADED" | "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";
  available: boolean;
  /** 本次渲染时签发的短时链接令牌（5 分钟有效），原图已撤销时为空 */
  token: string | null;
}

export interface ProgressView {
  status: "UPLOADING" | "RECOGNIZING" | "PENDING_CONFIRM" | "CONFIRMED";
  total: number;
  uploaded: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  finished: boolean;
  canStart: boolean;
  canRetry: boolean;
  canSkip: boolean;
}

const STATUS_LABEL: Record<ShotView["status"], string> = {
  UPLOADED: "已上传",
  QUEUED: "排队中",
  RUNNING: "识别中",
  DONE: "已识别",
  FAILED: "识别失败",
  SKIPPED: "已跳过",
};

/** 截图缩略图（通过短时签名链接加载，经过登录与归属校验）。 */
export function ShotThumb({ shot }: { shot: ShotView }) {
  if (!shot.token) {
    return <div className="flex h-24 w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">原图已删除</div>;
  }
  return (
    // 带签名令牌的私有链接，不适合 next/image 的优化与缓存
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/files/${shot.token}`} alt={`截图 ${shot.idx + 1}`} className="h-24 w-full rounded-md object-cover object-top" loading="lazy" />
  );
}

/** 截图批次在“上传 → 识别中 → 有失败项”阶段的页面主体。 */
export function ScreenshotStage({
  personId,
  batchId,
  shots,
  progress,
  quotaAvailable,
  perBatch,
  consented,
  provider,
}: {
  personId: string;
  batchId: string;
  shots: ShotView[];
  progress: ProgressView;
  quotaAvailable: number;
  perBatch: number;
  consented: boolean;
  provider: ProviderInfo;
}) {
  const uploading = progress.status === "UPLOADING";
  const running = progress.queued + progress.running;
  const processed = progress.done + progress.failed + progress.skipped;
  const enough = quotaAvailable >= progress.uploaded;

  const progressText =
    running > 0
      ? `正在识别… 已处理 ${processed} / ${progress.total} 张`
      : progress.failed > 0
        ? `已处理 ${processed} / ${progress.total} 张，有 ${progress.failed} 张识别失败`
        : "识别完成";

  return (
    <div className="space-y-4" data-testid="screenshot-stage">
      <AutoRefresh active={!uploading && running > 0} />

      {uploading && (
        <Card>
          <CardTitle>1. 上传截图</CardTitle>
          <ScreenshotUploader batchId={batchId} remaining={Math.max(perBatch - progress.total, 0)} />
        </Card>
      )}

      {!uploading && (
        <Card data-testid="progress-card" className={running > 0 ? "border-primary" : undefined}>
          <CardTitle>识别进度</CardTitle>
          <p className="text-sm" data-testid="progress-text">
            {progressText}
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={processed}>
            <div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? (processed / progress.total) * 100 : 0}%` }} />
          </div>
          {running > 0 && <p className="mt-2 text-xs text-muted-foreground">识别在后台进行，你可以离开这个页面，稍后回来查看；刷新页面进度不会丢失。</p>}
          {progress.finished && progress.failed > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground">失败的截图不会扣识别额度。你可以只重试失败的，或者跳过它们，用已识别的内容继续。</p>
              <div className="flex flex-wrap gap-2">
                {progress.canRetry && (
                  <ActionButton action={retryFailedAction.bind(null, personId, batchId)} variant="outline">
                    重试失败的 {progress.failed} 张
                  </ActionButton>
                )}
                {progress.canSkip && (
                  <ActionButton action={skipFailedAction.bind(null, personId, batchId)} variant="ghost">
                    跳过失败的，继续
                  </ActionButton>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>{uploading ? `已上传（${shots.length}）` : `截图（${shots.length}）`}</CardTitle>
        {shots.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有上传截图。</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="shot-list">
            {shots.map((s) => (
              <li key={s.id} className="space-y-1" data-testid={`shot-${s.idx}`}>
                <ShotThumb shot={s} />
                <div className="flex items-center justify-between gap-1 text-xs">
                  <Badge tone={s.status === "FAILED" ? "warn" : s.status === "DONE" ? "primary" : "muted"}>
                    {s.idx + 1} · {STATUS_LABEL[s.status]}
                  </Badge>
                  {uploading && (
                    <form action={removeScreenshotAction.bind(null, personId, batchId, s.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`移除第 ${s.idx + 1} 张`}>
                        移除
                      </Button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {uploading && !consented && <ConsentCard provider={provider} action="截图识别" />}

      {uploading && consented && (
        <Card>
          <CardTitle>2. 开始识别</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground" data-testid="quota-hint">
            将识别 {progress.uploaded} 张，消耗 {progress.uploaded} 张识别额度（当前剩余 {quotaAvailable} 张）。识别失败的不扣额度。
          </p>
          {!enough && <p className="mb-3 text-sm text-red-700">识别额度不足，请减少截图数量或联系管理员补发。</p>}
          <ActionButton action={startRecognitionAction.bind(null, personId, batchId)} size="lg" className="w-full" disabled={!progress.canStart || !enough} pendingText="正在提交…">
            开始识别
          </ActionButton>
        </Card>
      )}
    </div>
  );
}
