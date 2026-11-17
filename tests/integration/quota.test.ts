import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createQuota, InsufficientQuotaError, QuotaError } from "@/server/quota/ledger";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

describe("额度账本", () => {
  it("新用户在首个周期自动获得默认额度（截图 120、分析 8）", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(120);
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(8);
  });
});

describe("额度预留、结算与退还", () => {
  it("预留立即减少可用额度；结算后保持已消耗", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "SCREENSHOT", 10, "batch-1");
    expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(110);
    await quota.settle(user.id, "SCREENSHOT", "batch-1");
    expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(110);
  });

  it("额度不足时拒绝且不改变可用额度", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await expect(quota.reserve(user.id, "ANALYSIS", 9, "a-1")).rejects.toBeInstanceOf(InsufficientQuotaError);
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(8);
  });

  it("同一任务重试不重复预留", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "ANALYSIS", 1, "a-retry");
    await quota.reserve(user.id, "ANALYSIS", 1, "a-retry");
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(7);
  });

  it("系统失败退还全部预留，重复退还不重复入账", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "ANALYSIS", 1, "a-fail");
    await quota.release(user.id, "ANALYSIS", "a-fail");
    await quota.release(user.id, "ANALYSIS", "a-fail");
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(8);
  });

  it("退还后沿用同一任务键重试会被拒绝（不能免费执行）；换用新任务键重新预留，成功后只扣一次", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "ANALYSIS", 1, "job-1:attempt-1");
    await quota.release(user.id, "ANALYSIS", "job-1:attempt-1");
    await expect(quota.reserve(user.id, "ANALYSIS", 1, "job-1:attempt-1")).rejects.toBeInstanceOf(QuotaError);
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(8);

    await quota.reserve(user.id, "ANALYSIS", 1, "job-1:attempt-2");
    await quota.settle(user.id, "ANALYSIS", "job-1:attempt-2");
    await quota.reserve(user.id, "ANALYSIS", 1, "job-1:attempt-2");
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(7);
  });

  it("已结算的任务不能再退还", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "ANALYSIS", 1, "a-done");
    await quota.settle(user.id, "ANALYSIS", "a-done");
    await expect(quota.release(user.id, "ANALYSIS", "a-done")).rejects.toThrow();
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(7);
  });

  it("部分成功：按实际使用量结算，其余退还", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.reserve(user.id, "SCREENSHOT", 10, "batch-partial");
    await quota.settle(user.id, "SCREENSHOT", "batch-partial", { used: 8 });
    expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(112);
  });

  it("并发预留不会超额：120 额度、每次 10，最多成功 12 次", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => quota.reserve(user.id, "SCREENSHOT", 10, `race-${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(0);
  });

  it("并发重试同一任务只预留一次", async () => {
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await Promise.all(Array.from({ length: 5 }, () => quota.reserve(user.id, "ANALYSIS", 2, "same-task")));
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(6);
  });
});

describe("补发与周期", () => {
  it("管理员补发增加当期额度并记录操作者", async () => {
    const admin = await makeUser(ctx.db, { role: "ADMIN" });
    const user = await makeUser(ctx.db);
    const quota = createQuota(ctx.db);
    await quota.grant(user.id, "ANALYSIS", 5, { actorId: admin.id, reason: "内测补发" });
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(13);
    const entry = await ctx.db.quotaEntry.findFirstOrThrow({ where: { userId: user.id, reason: "内测补发" } });
    expect(entry.actorId).toBe(admin.id);
  });

  it("进入下一个 30 天周期后重新发放，上期消耗与补发不结转", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const user = await makeUser(ctx.db, { createdAt: created });
    let now = new Date("2026-01-10T00:00:00Z");
    const quota = createQuota(ctx.db, { now: () => now });
    await quota.reserve(user.id, "ANALYSIS", 8, "p0-all");
    await quota.settle(user.id, "ANALYSIS", "p0-all");
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(0);
    now = new Date("2026-02-05T00:00:00Z"); // 第 2 个周期
    expect(await quota.getAvailable(user.id, "ANALYSIS")).toBe(8);
  });

  it("汇总返回各类剩余量与本周期重置时间", async () => {
    const user = await makeUser(ctx.db, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const quota = createQuota(ctx.db, { now: () => new Date("2026-01-10T00:00:00Z") });
    const s = await quota.getSummary(user.id);
    expect(s.SCREENSHOT).toBe(120);
    expect(s.ANALYSIS).toBe(8);
    expect(s.resetsAt.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});
