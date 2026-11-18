import type { Feeling } from "@/generated/prisma/enums";
import type { Db } from "@/server/db";
import type { AnalysisService } from "@/server/analysis/service";
import type { Preferences } from "@/server/preferences/service";
import type { Freshness } from "@/domain/analysis/freshness";
import { RULES_EXPERIMENTAL, RULES_VERSION } from "@/domain/analysis/rules";
import { buildComparison, type Comparison, type PersonStage, type RankingCandidate } from "@/domain/scoring/ranking";
import type { DimensionResults, FitScore, Importance } from "@/domain/scoring/score";
import { computeTrend, type TrendResult } from "@/domain/scoring/trend";

export interface CompareEntry {
  personId: string;
  nickname: string;
  stage: PersonStage | null;
  /** “我的好感”：只展示，不参与任何计算 */
  feeling: Feeling | null;
  /** 最新报告的新鲜度；没有报告为 null */
  freshness: Freshness | null;
  /** 有分析正在进行 */
  running: boolean;
  /** 最新报告的资料截止时间 */
  snapshotAt: Date | null;
  /** 最新报告里各维度的状态与等级建议 */
  dimensions: DimensionResults | null;
  explicitRefusal: boolean;
  /** 最新报告的适配分（按报告当时的偏好）；没有报告为 null */
  fit: FitScore | null;
}

export interface CompareOverview {
  rulesVersion: string;
  experimental: boolean;
  /** 当前偏好版本与重要程度（排名按它加权） */
  preferenceVersion: number;
  importance: Importance;
  entries: CompareEntry[];
  comparison: Comparison;
}

/**
 * 对比服务：从已保存的分析结果、当前偏好与对象阶段汇聚出排名/待了解/趋势所需的数据，计算全部交给 domain/scoring 的纯函数。
 * 所有方法以 userId 限定范围：只看当前用户的、未被删除的对象。
 */
export function createCompare(db: Db, deps: { analysis: Pick<AnalysisService, "getReport" | "listSnapshots">; preferences: Pick<Preferences, "get"> }) {
  async function overview(userId: string): Promise<CompareOverview> {
    const [prefs, people] = await Promise.all([
      deps.preferences.get(userId),
      db.person.findMany({
        where: { userId, status: "ACTIVE" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: { id: true, nickname: true, stage: true, feelings: { orderBy: { createdAt: "desc" }, take: 1, select: { value: true } } },
      }),
    ]);

    const entries: CompareEntry[] = [];
    for (const p of people) {
      const report = await deps.analysis.getReport(userId, p.id);
      const latest = report.latest;
      entries.push({
        personId: p.id,
        nickname: p.nickname,
        stage: p.stage,
        feeling: p.feelings[0]?.value ?? null,
        freshness: report.freshness,
        running: report.running !== null,
        snapshotAt: latest?.snapshotAt ?? null,
        dimensions: latest ? latest.output.dimensions : null,
        explicitRefusal: latest?.explicitRefusal ?? false,
        fit: latest?.fit ?? null,
      });
    }

    const candidates: RankingCandidate[] = entries.map((e) => ({ id: e.personId, stage: e.stage, explicitRefusal: e.explicitRefusal, freshness: e.freshness, dimensions: e.dimensions }));
    return {
      rulesVersion: RULES_VERSION,
      experimental: RULES_EXPERIMENTAL,
      preferenceVersion: prefs.version,
      importance: prefs.importance,
      entries,
      comparison: buildComparison(candidates, prefs.importance),
    };
  }

  /** 某个对象的适配分趋势：按各份成功分析当时的规则/偏好版本比较；口径不同只标注“口径变化”。 */
  async function trend(userId: string, personId: string): Promise<{ trend: TrendResult; snapshotCount: number }> {
    const snapshots = await deps.analysis.listSnapshots(userId, personId); // 同时校验归属
    return {
      trend: computeTrend(snapshots.map((s) => ({ id: s.id, snapshotAt: s.snapshotAt, rulesVersion: s.rulesVersion, preferenceVersion: s.preferenceVersion, score: s.fit.kind === "scored" ? s.fit.score : null }))),
      snapshotCount: snapshots.length,
    };
  }

  return { overview, trend };
}

export type Compare = ReturnType<typeof createCompare>;
