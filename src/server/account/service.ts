import type { Db } from "@/server/db";
import type { FileStorage } from "@/server/storage/types";
import { NotFoundError, ValidationError } from "@/server/errors";
import { createPeople } from "@/server/people/service";

/**
 * 账户删除全流程（docs/business/privacy-retention.md §2、§6）：
 * 1. begin：同一事务内加锁并置“删除中”、清除全部会话——立即停用，不能再登录或发起新任务；
 * 2. complete：按删除围栏逐个删除对象（运行中的分析/识别任务随之失效，迟到的写回被拒绝），
 *    删除原图文件，最后删除账户行，其余在线数据（偏好、额度流水、同意记录、邀请码核销）随之级联删除；
 * 3. 只留两条审计记录（开始、完成），只含用户 ID 与对象数量，不含任何内容或手机号。
 * 两步都可重入：中途失败（进程崩溃、存储暂时不可用）时用户停留在“删除中”，由 worker 的清扫任务继续完成。
 * 备份、对象存储历史版本、AI 服务商侧的留存条件尚未核实，这里不作承诺。
 */
export function createAccount(db: Db, deps: { storage: FileStorage; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const people = createPeople(db); // 不传额度：账户整体删除，额度流水随账户一起删除，无需逐笔退还

  /** 第一步：立即停用。最后一个启用的管理员不能删除自己（否则没人能管理系统）。 */
  async function begin(userId: string): Promise<void> {
    await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ role: string; status: string }[]>`SELECT "role"::text AS "role", "status"::text AS "status" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = rows[0];
      if (!user) throw new NotFoundError("用户");
      if (user.status === "DELETING") return; // 重复请求：继续完成即可
      if (user.role === "ADMIN") {
        const others = await tx.user.count({ where: { role: "ADMIN", status: "ACTIVE", id: { not: userId } } });
        if (others === 0) throw new ValidationError("你是唯一的管理员，不能删除自己的账户。请先指定另一位管理员");
      }
      await tx.user.update({ where: { id: userId }, data: { status: "DELETING" } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.auditLog.create({ data: { actorId: userId, action: "account.delete.start", targetType: "User", targetId: userId, createdAt: now() } });
    });
  }

  /** 第二步：删除全部在线数据与文件。只处理“删除中”的账户。 */
  async function complete(userId: string): Promise<void> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user) return; // 已完成
    if (user.status !== "DELETING") throw new ValidationError("账户不在删除流程中");

    // 先记下原图文件：对象删除会级联删除截图记录
    const keys = (await db.screenshot.findMany({ where: { userId, purgedAt: null }, select: { storageKey: true } })).map((s) => s.storageKey);
    const personIds = (await db.person.findMany({ where: { userId }, select: { id: true } })).map((p) => p.id);
    let removed = 0;
    for (const id of personIds) {
      try {
        await people.remove(userId, id); // 删除围栏：先锁对象并递增代际，再级联删除；运行中的任务写回时被拒绝
        removed++;
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e; // 已被并发的另一次删除处理
      }
    }
    for (const key of keys) await deps.storage.delete(key).catch(() => {}); // 失败的留给孤儿文件清理（worker 每小时）
    await db.user.deleteMany({ where: { id: userId, status: "DELETING" } });
    await db.auditLog.create({ data: { actorId: userId, action: "account.delete.complete", targetType: "User", targetId: userId, meta: { people: removed }, createdAt: now() } });
  }

  async function deleteAccount(userId: string): Promise<void> {
    await begin(userId);
    await complete(userId);
  }

  /** worker 清扫：继续完成因故中断的删除。返回完成的账户数。 */
  async function sweepDeleting(): Promise<number> {
    const rows = await db.user.findMany({ where: { status: "DELETING" }, select: { id: true } });
    let n = 0;
    for (const r of rows) {
      await complete(r.id);
      n++;
    }
    return n;
  }

  return { begin, complete, deleteAccount, sweepDeleting };
}

export type Account = ReturnType<typeof createAccount>;
