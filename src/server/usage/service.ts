import type { Db } from "@/server/db";
import { costPricing, estimateCostMicroYuan, summarizeUsage, type CostPricing, type UsageKindKey, type UsageSample } from "@/domain/cost";

export interface UsageEntry {
  userId: string;
  kind: UsageKindKey;
  /** 分析 ID 或截图 ID */
  taskId: string;
  modelId: string;
  simulated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  success: boolean;
}

/**
 * 模型用量记录：每次 AI 服务商调用一条，只含类型、模型、用量、耗时、成功与否和估算成本，**不含任何聊天内容**。
 * 记录是尽力而为：写入失败只记一条不含内容的日志，绝不影响分析或识别本身（也不影响用户额度）。
 */
export function createUsage(db: Db, deps: { now?: () => Date; pricing?: CostPricing } = {}) {
  const pricing = deps.pricing ?? costPricing;
  const now = deps.now ?? (() => new Date());

  async function record(entries: UsageEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await db.modelUsage.createMany({
        data: entries.map((e) => ({ ...e, costMicroYuan: estimateCostMicroYuan(e, pricing), createdAt: now() })),
      });
    } catch (e) {
      console.error("[usage] 写入用量记录失败", e instanceof Error ? e.name : "unknown");
    }
  }

  /** 最近 days 天的用量汇总（后台成本页）。 */
  async function summary(days: number) {
    const since = new Date(now().getTime() - days * 86_400_000);
    const rows = await db.modelUsage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
    const samples: UsageSample[] = rows.map((r) => ({
      kind: r.kind,
      taskId: r.taskId,
      modelId: r.modelId,
      simulated: r.simulated,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      durationMs: r.durationMs,
      success: r.success,
      costMicroYuan: r.costMicroYuan,
      createdAt: r.createdAt,
    }));
    return summarizeUsage(samples);
  }

  return { record, summary };
}

export type Usage = ReturnType<typeof createUsage>;
