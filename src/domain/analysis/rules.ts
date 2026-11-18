import { z } from "zod";
import raw from "../../../config/scoring/v0.json";

const schema = z.object({
  version: z.string().min(1),
  status: z.enum(["experimental", "active"]),
  dimensions: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(1),
  levels: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), score: z.number() })).min(2),
  importance: z.object({ min: z.number().int(), max: z.number().int(), default: z.number().int() }),
  evidence: z.object({
    sufficient: z.object({ minUnits: z.number().int().positive(), minDistinctContexts: z.number().int().positive() }),
    clue: z.object({ minUnits: z.number().int().positive() }),
    unitWindowMinutes: z.number().positive(),
    curatedOrUncertainCapAtClue: z.array(z.string()),
  }),
  total: z.object({ requiresAllDimensionsKnown: z.boolean(), scoreDecimals: z.number().int().min(0).max(3) }),
  ranking: z.object({
    /** 阶段键与对象档案里的阶段枚举一致（JUST_MET / GETTING_TO_KNOW …） */
    eligibleStages: z.array(z.enum(["JUST_MET", "GETTING_TO_KNOW", "IN_RELATIONSHIP", "ENDED"])),
    minCommonKnownDimensions: z.number().int().positive(),
    criticalImportance: z.number().int(),
    ineligibleFlags: z.array(z.string()),
    tiesShareRank: z.boolean(),
  }),
  trend: z.object({
    minComparableSnapshots: z.number().int().min(2),
    minDeltaPoints: z.number().positive(),
    maxSnapshots: z.number().int().min(2),
    requireSameRuleVersion: z.boolean(),
    requireSamePreferenceVersion: z.boolean(),
  }),
});

export type ScoringRules = z.infer<typeof schema>;

/** 评分与证据规则的唯一来源：config/scoring/v0.json（见 docs/scoring/rules-v0-experimental.md）。 */
export const scoringRules: ScoringRules = schema.parse(raw);

export const RULES_VERSION = scoringRules.version;
/** 实验规则完成样本评测并经确认前，界面必须标注“实验规则”。 */
export const RULES_EXPERIMENTAL = scoringRules.status === "experimental";

export const DIMENSION_KEYS = scoringRules.dimensions.map((d) => d.key);
export const dimensionLabel = (key: string) => scoringRules.dimensions.find((d) => d.key === key)?.label ?? key;
export const LEVEL_KEYS = scoringRules.levels.map((l) => l.key);
export const levelLabel = (key: string) => scoringRules.levels.find((l) => l.key === key)?.label ?? key;
