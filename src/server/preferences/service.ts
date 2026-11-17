import type { Db } from "@/server/db";
import { DEFAULT_PREFERENCES, preferenceInputSchema, type PreferenceInput, type PreferenceValues } from "@/domain/preferences";
import { ValidationError } from "@/server/errors";

export interface PreferenceView extends PreferenceValues {
  /** 0 表示从未保存（使用公开默认配置）；每次实际修改 +1 */
  version: number;
  isDefault: boolean;
}

const same = (a: PreferenceValues, b: PreferenceValues) =>
  a.expectation === b.expectation &&
  a.contactFrequency === b.contactFrequency &&
  a.pace === b.pace &&
  JSON.stringify(Object.entries(a.importance).sort()) === JSON.stringify(Object.entries(b.importance).sort());

/**
 * 同一用户对所有对象使用统一偏好。版本号随实际修改递增，
 * 分析快照记录它，因此偏好变更可使旧分析被标记为"待更新"。
 */
export function createPreferences(db: Db) {
  const view = (values: PreferenceValues, version: number): PreferenceView => ({
    ...values,
    version,
    isDefault: same(values, DEFAULT_PREFERENCES),
  });

  async function get(userId: string): Promise<PreferenceView> {
    const row = await db.preference.findUnique({ where: { userId } });
    if (!row) return view(DEFAULT_PREFERENCES, 0);
    return view(
      {
        expectation: row.expectation,
        contactFrequency: row.contactFrequency,
        pace: row.pace,
        importance: row.importance as Record<string, number>,
      },
      row.version,
    );
  }

  async function save(userId: string, input: PreferenceInput): Promise<PreferenceView> {
    const parsed = preferenceInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "偏好无效");
    const next: PreferenceValues = {
      expectation: parsed.data.expectation ?? null,
      contactFrequency: parsed.data.contactFrequency ?? null,
      pace: parsed.data.pace ?? null,
      importance: parsed.data.importance,
    };
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pref:${userId}`}, 0))`;
      const row = await tx.preference.findUnique({ where: { userId } });
      const current = row
        ? { expectation: row.expectation, contactFrequency: row.contactFrequency, pace: row.pace, importance: row.importance as Record<string, number> }
        : null;
      if (current && same(current, next)) return view(next, row!.version);
      const saved = await tx.preference.upsert({
        where: { userId },
        create: { userId, ...next, version: 1 },
        update: { ...next, version: { increment: 1 } },
      });
      return view(next, saved.version);
    });
  }

  /** 恢复默认配置；会产生新版本，旧分析因此被标记为待更新。 */
  function reset(userId: string): Promise<PreferenceView> {
    return save(userId, DEFAULT_PREFERENCES as PreferenceInput);
  }

  return { get, save, reset };
}

export type Preferences = ReturnType<typeof createPreferences>;
