import { z } from "zod";
import raw from "../../../config/quota.json";

const schema = z.object({
  periodDays: z.number().int().positive(),
  screenshot: z.object({ perPeriod: z.number().int().nonnegative(), perBatch: z.number().int().positive() }),
  analysis: z.object({ perPeriod: z.number().int().nonnegative() }),
  textPerBatchChars: z.number().int().positive(),
});

export type QuotaConfig = z.infer<typeof schema>;

/** 额度默认值唯一来源：config/quota.json（见 docs/business/quota.md）。 */
export const quotaConfig: QuotaConfig = schema.parse(raw);
