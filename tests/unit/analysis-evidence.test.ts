import { describe, expect, it } from "vitest";
import { assessEvidence, type EvidenceMessage } from "@/domain/analysis/evidence";
import { scoringRules } from "@/domain/analysis/rules";

const MIN = 60_000;
const T0 = new Date("2026-03-01T12:00:00Z").getTime();
const DAY = 86_400_000;

let n = 0;
/** 一条带可靠时间的证据消息（北京时间的日期由 T0 + 偏移决定） */
const timed = (offsetMs: number, over: Partial<EvidenceMessage> = {}): EvidenceMessage => ({
  id: `m${n++}`,
  batchId: "b1",
  seq: n,
  occurredAt: new Date(T0 + offsetMs),
  timePrecision: "MINUTE",
  dataKind: "CONTINUOUS",
  ...over,
});
const untimed = (seq: number, batchId = "b1", dataKind: EvidenceMessage["dataKind"] = "CONTINUOUS"): EvidenceMessage => ({
  id: `u${n++}`,
  batchId,
  seq,
  occurredAt: null,
  timePrecision: "UNKNOWN",
  dataKind,
});

describe("证据充分度（程序按规则核验，不采信模型自称）", () => {
  it("0 条证据：资料不足", () => {
    expect(assessEvidence("follow_through", [])).toMatchObject({ status: "insufficient", units: 0, contexts: 0 });
  });

  it("1–2 个证据单元：线索（展示但不计分）", () => {
    expect(assessEvidence("follow_through", [timed(0)]).status).toBe("clue");
    expect(assessEvidence("follow_through", [timed(0), timed(DAY)]).status).toBe("clue");
  });

  it("≥3 个单元且跨 ≥2 个日期：已知", () => {
    const r = assessEvidence("follow_through", [timed(0), timed(DAY), timed(2 * DAY)]);
    expect(r).toMatchObject({ status: "known", units: 3, contexts: 3 });
  });

  it("同一 30 分钟窗口内的消息合并为一个单元：5 条紧挨着的消息只算 1 个单元", () => {
    const burst = [0, 5, 10, 20, 29].map((m) => timed(m * MIN));
    expect(assessEvidence("follow_through", burst)).toMatchObject({ status: "clue", units: 1 });
  });

  it("窗口按相邻消息的间隔判断：每次间隔不超过 30 分钟就连成一个单元，超过则新开一个", () => {
    const chained = [0, 25, 50, 75].map((m) => timed(m * MIN)); // 相邻间隔 25 分钟
    expect(assessEvidence("follow_through", chained).units).toBe(1);
    const split = [0, 31].map((m) => timed(m * MIN));
    expect(assessEvidence("follow_through", split).units).toBe(2);
  });

  it("3 个单元但都在同一天：不够“已知”（需要 ≥2 个情境）", () => {
    const sameDay = [0, 60, 120].map((m) => timed(m * MIN));
    expect(assessEvidence("follow_through", sameDay)).toMatchObject({ status: "clue", units: 3, contexts: 1 });
  });

  it("时间未知的消息不能证明跨日期：只能按来源批次区分情境", () => {
    // 同一批次里 3 处互不相邻的无时间证据：3 个单元，但只有 1 个情境
    const sameBatch = [untimed(1), untimed(10), untimed(20)];
    expect(assessEvidence("follow_through", sameBatch)).toMatchObject({ status: "clue", units: 3, contexts: 1 });
    // 来自 3 个不同批次：情境 3 个，可以“已知”
    const acrossBatches = [untimed(1, "b1"), untimed(1, "b2"), untimed(1, "b3")];
    expect(assessEvidence("follow_through", acrossBatches)).toMatchObject({ status: "known", units: 3, contexts: 3 });
  });

  it("仅有日期精度的时间可以区分日期，但不能用来合并成同一窗口", () => {
    const dated = (offset: number) => timed(offset, { timePrecision: "DATE" });
    expect(assessEvidence("follow_through", [dated(0), dated(DAY), dated(2 * DAY)])).toMatchObject({ status: "known", contexts: 3 });
  });

  it("“双向投入”只有精选片段/不确定资料的证据时，最多到“线索”，不论有多少", () => {
    const curated = [0, 1, 2, 3].map((d) => timed(d * DAY, { dataKind: "CURATED" }));
    expect(assessEvidence("mutual_investment", curated)).toMatchObject({ status: "clue", cappedBy: "CURATED_OR_UNCERTAIN" });
    const uncertain = [0, 1, 2, 3].map((d) => timed(d * DAY, { dataKind: "UNCERTAIN" }));
    expect(assessEvidence("mutual_investment", uncertain).status).toBe("clue");
  });

  it("同样的精选片段证据对其他维度不设限（可以支持具体表达分析）", () => {
    const curated = [0, 1, 2].map((d) => timed(d * DAY, { dataKind: "CURATED" }));
    expect(assessEvidence("willingness_to_know", curated).status).toBe("known");
  });

  it("“双向投入”有足够的连续聊天证据时仍可为“已知”；精选片段的证据不被计入", () => {
    const mixed = [
      timed(0),
      timed(DAY),
      timed(2 * DAY),
      timed(3 * DAY, { dataKind: "CURATED" }),
    ];
    expect(assessEvidence("mutual_investment", mixed)).toMatchObject({ status: "known", units: 3 });
    const onlyTwoContinuous = [timed(0), timed(DAY), timed(2 * DAY, { dataKind: "CURATED" }), timed(3 * DAY, { dataKind: "CURATED" })];
    expect(assessEvidence("mutual_investment", onlyTwoContinuous).status).toBe("clue");
  });

  it("同一条消息被重复引用只算一次", () => {
    const m = timed(0);
    expect(assessEvidence("follow_through", [m, m, m]).units).toBe(1);
  });

  it("阈值来自配置而不是写死在代码里", () => {
    expect(scoringRules.evidence.sufficient).toEqual({ minUnits: 3, minDistinctContexts: 2 });
    expect(scoringRules.evidence.unitWindowMinutes).toBe(30);
  });
});
