import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createPreferences } from "@/server/preferences/service";
import { ValidationError } from "@/server/people/service";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let prefs: ReturnType<typeof createPreferences>;
beforeAll(async () => {
  ctx = await newTestDb();
  prefs = createPreferences(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

const equal = { mutual_investment: 3, willingness_to_know: 3, follow_through: 3, communication_boundaries: 3, pace_alignment: 3 };

describe("个人偏好", () => {
  it("未设置时使用公开默认配置：版本 0、五维同等重要", async () => {
    const u = await makeUser(ctx.db);
    const p = await prefs.get(u.id);
    expect(p.version).toBe(0);
    expect(p.isDefault).toBe(true);
    expect(p.importance).toEqual(equal);
    expect(p.expectation).toBeNull();
  });

  it("每次实际修改版本号 +1；保存相同内容不改变版本", async () => {
    const u = await makeUser(ctx.db);
    const a = await prefs.save(u.id, { expectation: "GET_TO_KNOW", contactFrequency: "DAILY", pace: "SLOW", importance: equal });
    expect(a.version).toBe(1);
    const same = await prefs.save(u.id, { expectation: "GET_TO_KNOW", contactFrequency: "DAILY", pace: "SLOW", importance: equal });
    expect(same.version).toBe(1);
    const b = await prefs.save(u.id, { expectation: "GET_TO_KNOW", contactFrequency: "DAILY", pace: "SLOW", importance: { ...equal, follow_through: 5 } });
    expect(b.version).toBe(2);
    expect(b.isDefault).toBe(false);
  });

  it("恢复默认也会产生新版本，使旧分析可被标记为待更新", async () => {
    const u = await makeUser(ctx.db);
    await prefs.save(u.id, { importance: { ...equal, pace_alignment: 1 } });
    const r = await prefs.reset(u.id);
    expect(r.version).toBe(2);
    expect(r.isDefault).toBe(true);
    expect(r.importance).toEqual(equal);
  });

  it.each([
    ["超出范围", { ...equal, follow_through: 6 }],
    ["低于下限", { ...equal, follow_through: 0 }],
    ["非整数", { ...equal, follow_through: 2.5 }],
    ["缺少维度", { mutual_investment: 3 }],
    ["未知维度", { ...equal, values: 3 }],
  ])("拒绝无效的重要程度：%s", async (_label, importance) => {
    const u = await makeUser(ctx.db);
    await expect(prefs.save(u.id, { importance: importance as never })).rejects.toBeInstanceOf(ValidationError);
    expect((await prefs.get(u.id)).version).toBe(0);
  });

  it("偏好按用户隔离", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    await prefs.save(a.id, { importance: { ...equal, follow_through: 5 } });
    expect((await prefs.get(b.id)).version).toBe(0);
    expect((await prefs.get(b.id)).importance.follow_through).toBe(3);
  });
});
