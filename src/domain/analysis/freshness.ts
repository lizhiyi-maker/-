export type Freshness = "FRESH" | "NEW_DATA" | "PREFERENCE_CHANGED" | "RULES_CHANGED" | "CORRECTED_EXPIRED";

export interface FreshnessReport {
  rulesVersion: string;
  preferenceVersion: number;
}

export interface FreshnessCurrent {
  rulesVersion: string;
  preferenceVersion: number;
  /** 报告生成之后又保存了新的资料 */
  hasNewData: boolean;
  /** 报告引用的消息已被修改或所属批次已被删除 */
  hasStaleRefs: boolean;
}

/**
 * 报告相对当前数据的状态。多条同时成立时按优先级取一
 * （docs/business/state-machines.md §4）：资料纠正已过期 > 规则变更 > 偏好变更 > 有新资料 > 最新。
 */
export function computeFreshness(report: FreshnessReport, current: FreshnessCurrent): Freshness {
  if (current.hasStaleRefs) return "CORRECTED_EXPIRED";
  if (current.rulesVersion !== report.rulesVersion) return "RULES_CHANGED";
  if (current.preferenceVersion !== report.preferenceVersion) return "PREFERENCE_CHANGED";
  if (current.hasNewData) return "NEW_DATA";
  return "FRESH";
}

export const FRESHNESS_LABEL: Record<Freshness, { label: string; hint: string }> = {
  FRESH: { label: "最新", hint: "报告基于你目前保存的全部资料。" },
  NEW_DATA: { label: "有新资料待分析", hint: "报告生成之后又有新的资料。新增资料不会自动分析，准备好后由你决定何时重新分析。" },
  PREFERENCE_CHANGED: {
    label: "偏好变更待更新",
    hint: "你修改了个人偏好。重新分析后的变化可能来自口径变化（偏好不同），而不是关系本身升温或降温。",
  },
  RULES_CHANGED: {
    label: "规则变更",
    hint: "分析规则已升级。重新分析后的变化可能来自口径变化（规则不同），而不是关系本身升温或降温。",
  },
  CORRECTED_EXPIRED: { label: "资料纠正已过期", hint: "报告引用的聊天资料已被修改或删除，其中的证据可能已不准确，建议重新分析。" },
};
