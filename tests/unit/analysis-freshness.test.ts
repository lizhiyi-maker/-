import { describe, expect, it } from "vitest";
import { computeFreshness, FRESHNESS_LABEL } from "@/domain/analysis/freshness";

const report = { rulesVersion: "v0", preferenceVersion: 2 };
const same = { rulesVersion: "v0", preferenceVersion: 2, hasNewData: false, hasStaleRefs: false };

describe("报告新鲜度", () => {
  it("一切未变：最新", () => {
    expect(computeFreshness(report, same)).toBe("FRESH");
  });

  it("每一种触发条件单独成立时对应各自的状态", () => {
    expect(computeFreshness(report, { ...same, hasNewData: true })).toBe("NEW_DATA");
    expect(computeFreshness(report, { ...same, preferenceVersion: 3 })).toBe("PREFERENCE_CHANGED");
    expect(computeFreshness(report, { ...same, rulesVersion: "v1" })).toBe("RULES_CHANGED");
    expect(computeFreshness(report, { ...same, hasStaleRefs: true })).toBe("CORRECTED_EXPIRED");
  });

  it("多条同时成立时按优先级取一：资料纠正已过期 > 规则变更 > 偏好变更 > 有新资料", () => {
    const all = { rulesVersion: "v1", preferenceVersion: 9, hasNewData: true, hasStaleRefs: true };
    expect(computeFreshness(report, all)).toBe("CORRECTED_EXPIRED");
    expect(computeFreshness(report, { ...all, hasStaleRefs: false })).toBe("RULES_CHANGED");
    expect(computeFreshness(report, { ...all, hasStaleRefs: false, rulesVersion: "v0" })).toBe("PREFERENCE_CHANGED");
    expect(computeFreshness(report, { ...all, hasStaleRefs: false, rulesVersion: "v0", preferenceVersion: 2 })).toBe("NEW_DATA");
  });

  it("偏好版本只在变化时才算变更：恢复默认（版本 0）后的报告与当前默认一致时仍是最新", () => {
    expect(computeFreshness({ rulesVersion: "v0", preferenceVersion: 0 }, { ...same, preferenceVersion: 0 })).toBe("FRESH");
  });

  it("每种状态都有中文说明；偏好/规则变更会提示分差属于口径变化", () => {
    expect(FRESHNESS_LABEL.FRESH.label).toBe("最新");
    expect(FRESHNESS_LABEL.NEW_DATA.label).toBe("有新资料待分析");
    expect(FRESHNESS_LABEL.CORRECTED_EXPIRED.label).toBe("资料纠正已过期");
    expect(FRESHNESS_LABEL.PREFERENCE_CHANGED.label).toBe("偏好变更待更新");
    expect(FRESHNESS_LABEL.RULES_CHANGED.label).toBe("规则变更");
    expect(FRESHNESS_LABEL.PREFERENCE_CHANGED.hint).toContain("口径");
    expect(FRESHNESS_LABEL.RULES_CHANGED.hint).toContain("口径");
  });
});
