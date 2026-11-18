import type { ExcludedReason, WaitingReason } from "./ranking";
import type { TrendResult } from "./trend";

export const EXCLUDED_LABEL: Record<ExcludedReason, { label: string; hint: string }> = {
  NO_ANALYSIS: { label: "还没有分析报告", hint: "先导入资料并开始分析。" },
  NO_STAGE: { label: "阶段未设置", hint: "阶段由你确认（AI 只能建议）。设置为“刚认识”或“正在了解”后才会参与同阶段对比。" },
  STAGE_NOT_ELIGIBLE: { label: "不参与发展排名", hint: "已确认关系和已结束的对象不参与发展排名，仍可查看记录。" },
  EXPLICIT_REFUSAL: { label: "对方明确表示不希望继续联系", hint: "不参与排名，也不再给出推进类建议。" },
  STALE_REPORT: { label: "报告需要重新分析", hint: "资料被纠正、偏好变更或规则升级后，旧报告不能与其他对象比较，请先重新分析。" },
};

export const WAITING_LABEL: Record<WaitingReason, { label: string; hint: string }> = {
  FEW_KNOWN: { label: "已知维度太少", hint: "已知的维度不足，只展示已知的部分，不参与排名。" },
  MISSING_CRITICAL: { label: "缺少你最看重的维度", hint: "你把重要程度设为最高的维度还没有足够证据，不参与排名。" },
  NOT_COMMON: { label: "与其他对象共同已知的维度不足", hint: "可比较的维度不够，不给名次，只并列展示已知的维度。" },
};

/** 趋势的展示文字。口径变化只标注，不显示升降。 */
export function trendText(t: TrendResult): { label: string; hint: string } {
  switch (t.kind) {
    case "UP":
      return { label: `上升 ${t.delta} 分`, hint: `最近 ${t.points.length} 份同口径分析的适配分变化。` };
    case "DOWN":
      return { label: `下降 ${Math.abs(t.delta)} 分`, hint: `最近 ${t.points.length} 份同口径分析的适配分变化。` };
    case "FLAT":
      return { label: "基本持平 / 不足以判断", hint: `最近 ${t.points.length} 份同口径分析的变化不到 8 分，不足以说明升温或降温。` };
    case "BASELINE_CHANGED": {
      const why = t.changed.map((c) => (c === "rules" ? "规则版本" : "偏好版本")).join("和");
      return { label: "口径变化，非关系变化", hint: `与上一份相比${why}不同，分差来自口径变化，不能解释为关系升温或降温，因此不显示趋势。` };
    }
    case "INSUFFICIENT":
      return { label: "暂时看不出趋势", hint: "需要至少 2 份同规则、同偏好、且五个维度都已知的分析，才能比较。" };
  }
}
