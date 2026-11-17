import { z } from "zod";

export const GENDER_LABEL = { MALE: "男", FEMALE: "女" } as const;
export const STAGE_LABEL = {
  JUST_MET: "刚认识",
  GETTING_TO_KNOW: "正在了解",
  IN_RELATIONSHIP: "已确认关系",
  ENDED: "已结束",
} as const;
export const PLATFORM_LABEL = { WECHAT: "微信", DOUYIN: "抖音", OTHER: "其他" } as const;
export const FEELING_LABEL = {
  UNSURE: "还不确定",
  WANT_TO_KNOW: "想继续了解",
  STRONG: "很心动",
  PAUSE: "暂时不想继续",
} as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const personInputSchema = z.object({
  nickname: z.string().trim().min(1, "请填写昵称或代号").max(40, "昵称最多 40 个字"),
  gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
  channel: optionalText(60),
  metAtApprox: optionalText(40),
  stage: z.enum(["JUST_MET", "GETTING_TO_KNOW", "IN_RELATIONSHIP", "ENDED"]).nullable().optional(),
  hasMet: z.boolean().nullable().optional(),
  seesAsAmbiguous: z.boolean().nullable().optional(),
  feelingsNote: optionalText(2000),
  expectationsNote: optionalText(2000),
});

export const personPatchSchema = personInputSchema.partial();

export const accountInputSchema = z.object({
  platform: z.enum(["WECHAT", "DOUYIN", "OTHER"]),
  handle: z.string().trim().min(1, "请填写账号或昵称").max(80),
});

export const feelingSchema = z.enum(["UNSURE", "WANT_TO_KNOW", "STRONG", "PAUSE"]);

export type PersonInput = z.input<typeof personInputSchema>;
export type PersonPatch = z.input<typeof personPatchSchema>;
export type AccountInput = z.input<typeof accountInputSchema>;
export type GenderFilter = "ALL" | "MALE" | "FEMALE";
