import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createPeople, NotFoundError, ValidationError } from "@/server/people/service";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let people: ReturnType<typeof createPeople>;
beforeAll(async () => {
  ctx = await newTestDb();
  people = createPeople(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

describe("对象档案", () => {
  it("只填昵称即可创建；未填性别的对象出现在「全部」而不在男/女列表", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "  小A  " });
    expect(p.nickname).toBe("小A");
    expect(p.gender).toBeNull();
    expect(p.stage).toBeNull();
    expect((await people.list(u.id, "ALL")).map((x) => x.id)).toContain(p.id);
    expect((await people.list(u.id, "MALE")).map((x) => x.id)).not.toContain(p.id);
    expect((await people.list(u.id, "FEMALE")).map((x) => x.id)).not.toContain(p.id);
  });

  it("昵称必填，空白昵称被拒绝", async () => {
    const u = await makeUser(ctx.db);
    await expect(people.create(u.id, { nickname: "   " })).rejects.toBeInstanceOf(ValidationError);
  });

  it("按性别筛选", async () => {
    const u = await makeUser(ctx.db);
    const m = await people.create(u.id, { nickname: "男生", gender: "MALE" });
    const f = await people.create(u.id, { nickname: "女生", gender: "FEMALE" });
    expect((await people.list(u.id, "MALE")).map((x) => x.id)).toEqual([m.id]);
    expect((await people.list(u.id, "FEMALE")).map((x) => x.id)).toEqual([f.id]);
    expect(await people.list(u.id, "ALL")).toHaveLength(2);
  });

  it("阶段、见面经历、是否暧昧相互独立记录", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "B", stage: "GETTING_TO_KNOW" });
    const updated = await people.update(u.id, p.id, { hasMet: true, seesAsAmbiguous: true });
    expect(updated.stage).toBe("GETTING_TO_KNOW");
    expect(updated.hasMet).toBe(true);
    expect(updated.seesAsAmbiguous).toBe(true);
    const changed = await people.update(u.id, p.id, { stage: "ENDED" });
    expect(changed.hasMet).toBe(true);
  });

  it("同昵称的对象不会被自动合并", async () => {
    const u = await makeUser(ctx.db);
    const a = await people.create(u.id, { nickname: "同名" });
    const b = await people.create(u.id, { nickname: "同名" });
    expect(a.id).not.toBe(b.id);
    expect((await people.list(u.id, "ALL")).filter((x) => x.nickname === "同名")).toHaveLength(2);
  });

  it("可为同一对象关联多个平台账号；重复关联被拒绝", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "C" });
    await people.addAccount(u.id, p.id, { platform: "WECHAT", handle: "wx_c" });
    await people.addAccount(u.id, p.id, { platform: "DOUYIN", handle: "dy_c" });
    await expect(people.addAccount(u.id, p.id, { platform: "WECHAT", handle: "wx_c" })).rejects.toBeInstanceOf(ValidationError);
    const detail = await people.get(u.id, p.id);
    expect(detail.accounts.map((a) => a.platform).sort()).toEqual(["DOUYIN", "WECHAT"]);
    await people.removeAccount(u.id, p.id, detail.accounts[0].id);
    expect((await people.get(u.id, p.id)).accounts).toHaveLength(1);
  });
});

describe("我的好感", () => {
  it("独立记录并保留每次修改的时间，当前值为最新一次", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "D" });
    expect((await people.get(u.id, p.id)).feeling).toBeNull();
    await people.setFeeling(u.id, p.id, "UNSURE");
    await people.setFeeling(u.id, p.id, "WANT_TO_KNOW");
    await people.setFeeling(u.id, p.id, "STRONG");
    const d = await people.get(u.id, p.id);
    expect(d.feeling?.value).toBe("STRONG");
    expect(d.feelingHistory.map((f) => f.value)).toEqual(["STRONG", "WANT_TO_KNOW", "UNSURE"]);
    expect(d.feeling?.createdAt).toBeInstanceOf(Date);
  });

  it("列表同时返回每个对象的当前好感", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "E" });
    await people.setFeeling(u.id, p.id, "PAUSE");
    const [row] = await people.list(u.id, "ALL");
    expect(row.feeling).toBe("PAUSE");
  });
});

describe("用户归属：跨用户访问一律视为不存在", () => {
  it("B 无法读取、修改、删除、操作 A 的对象，A 的数据保持不变", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    const p = await people.create(a.id, { nickname: "A的对象" });
    const acc = await people.addAccount(a.id, p.id, { platform: "WECHAT", handle: "secret" });

    await expect(people.get(b.id, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.update(b.id, p.id, { nickname: "篡改" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.setFeeling(b.id, p.id, "STRONG")).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.addAccount(b.id, p.id, { platform: "OTHER", handle: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.removeAccount(b.id, p.id, acc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.remove(b.id, p.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await people.list(b.id, "ALL")).toEqual([]);

    const still = await people.get(a.id, p.id);
    expect(still.nickname).toBe("A的对象");
    expect(still.accounts).toHaveLength(1);
    expect(still.feeling).toBeNull();
  });

  it("用 A 的账号 ID 配合 B 的对象 ID 也无法删除 A 的平台账号", async () => {
    const a = await makeUser(ctx.db);
    const b = await makeUser(ctx.db);
    const pa = await people.create(a.id, { nickname: "PA" });
    const pb = await people.create(b.id, { nickname: "PB" });
    const acc = await people.addAccount(a.id, pa.id, { platform: "WECHAT", handle: "h" });
    await expect(people.removeAccount(b.id, pb.id, acc.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await people.get(a.id, pa.id)).accounts).toHaveLength(1);
  });
});

describe("删除与删除围栏", () => {
  it("删除对象同时删除其平台账号与好感记录", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "F" });
    await people.addAccount(u.id, p.id, { platform: "WECHAT", handle: "f" });
    await people.setFeeling(u.id, p.id, "UNSURE");
    await people.remove(u.id, p.id);
    await expect(people.get(u.id, p.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await ctx.db.platformAccount.count({ where: { personId: p.id } })).toBe(0);
    expect(await ctx.db.feelingEntry.count({ where: { personId: p.id } })).toBe(0);
  });

  it("对象删除后，持有旧代际的后台任务不能写回，回调不会被执行", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "G" });
    const { generation } = await people.get(u.id, p.id);
    let wrote = false;
    await people.remove(u.id, p.id);
    await expect(
      people.withLivePerson(u.id, p.id, generation, async () => {
        wrote = true;
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(wrote).toBe(false);
  });

  it("任务写回与删除并发：写回要么在删除之前完整完成，要么被拒绝，不会在删除后写入", async () => {
    const u = await makeUser(ctx.db);
    const p = await people.create(u.id, { nickname: "H" });
    const { generation } = await people.get(u.id, p.id);
    const order: string[] = [];
    const task = people.withLivePerson(u.id, p.id, generation, async (tx) => {
      await new Promise((r) => setTimeout(r, 300));
      await tx.feelingEntry.create({ data: { personId: p.id, userId: u.id, value: "UNSURE" } });
      order.push("task-written");
    });
    await new Promise((r) => setTimeout(r, 50));
    const del = people.remove(u.id, p.id).then(() => order.push("deleted"));
    const [t] = await Promise.allSettled([task, del]);
    expect(t.status).toBe("fulfilled");
    expect(order).toEqual(["task-written", "deleted"]);
    expect(await ctx.db.feelingEntry.count({ where: { personId: p.id } })).toBe(0);
  });
});
