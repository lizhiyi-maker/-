import type { Db } from "@/server/db";
import { CONSENT_VERSION } from "@/domain/consent";
import { ConsentRequiredError } from "@/server/errors";

export interface ConsentOptions {
  /** 当前使用的 AI 服务商标识；换服务商后需要重新同意 */
  providerId: string;
  version?: number;
  now?: () => Date;
}

/** 首次向 AI 服务商发送任何内容之前（截图识别或关系分析，先发生者）必须记录用户的同意。 */
export function createConsent(db: Db, opts: ConsentOptions) {
  const version = opts.version ?? CONSENT_VERSION;
  const now = opts.now ?? (() => new Date());

  async function status(userId: string) {
    const row = await db.consentRecord.findUnique({ where: { userId_version_providerId: { userId, version, providerId: opts.providerId } } });
    return { accepted: row !== null, version, providerId: opts.providerId, acceptedAt: row?.acceptedAt ?? null };
  }

  /** 幂等：重复同意不产生新记录，保留首次同意的时间。 */
  async function accept(userId: string) {
    await db.consentRecord.upsert({
      where: { userId_version_providerId: { userId, version, providerId: opts.providerId } },
      create: { userId, version, providerId: opts.providerId, acceptedAt: now() },
      update: {},
    });
  }

  async function assertAccepted(userId: string) {
    if (!(await status(userId)).accepted) throw new ConsentRequiredError();
  }

  return { status, accept, assertAccepted };
}

export type Consent = ReturnType<typeof createConsent>;
