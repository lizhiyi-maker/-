import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createEvents } from "@/server/events/service";
import { createPeople } from "@/server/people/service";
import { NotFoundError, ValidationError } from "@/server/errors";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  ctx = await newTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-04-10T04:00:00Z"); // 北京时间 2026-04-10 12:00
const events = () => createEvents(ctx.db, { now: () => NOW });
const people = () => createPeople(ctx.db);

let seq = 0;
async function setup() {
  const user = await makeUser(ctx.db);
  const person = await people().create(user.id, { nickname: `阿青${seq++}` });
  return { user, person };
}

const MEET = { kind: "MEET", occurredOn: "2026-04-05", facts: "在咖啡店见面，聊了两个小时，她先结的账。", personalNote: "回来的路上有点紧张，但很开心" } as const;

describe("记录线下事件", () => {
  it("事实与个人感受分开保存：事实进入修订，个人感受只在事件行上", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    expect(e).toMatchObject({ kind: "MEET", facts: MEET.facts, personalNote: MEET.personalNote, revision: 1 });
    expect(e.occurredOn.toISOString().slice(0, 10)).toBe("2026-04-05");

    const revisions = await ctx.db.offlineEventRevision.findMany({ where: { eventId: e.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revision: 1, kind: "MEET", facts: MEET.facts });
    // 个人感受不得出现在修订（修订是证据的来源）里
    expect(JSON.stringify(revisions)).not.toContain("紧张");
  });

  it("个人感受可以留空；事实必填", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, { kind: "CALL", occurredOn: "2026-04-06", facts: "通话十分钟，约了周末", personalNote: "   " });
    expect(e.personalNote).toBeNull();
    await expect(events().create(s.user.id, s.person.id, { kind: "CALL", occurredOn: "2026-04-06", facts: "   " })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ["未知类型", { kind: "DATE" as never }],
    ["日期格式不对", { occurredOn: "2026/04/05" }],
    ["不存在的日期", { occurredOn: "2026-02-30" }],
    ["未来的日期（事件是已经发生的事）", { occurredOn: "2026-04-11" }],
    ["事实过长", { facts: "字".repeat(501) }],
    ["个人感受过长", { personalNote: "字".repeat(1001) }],
  ])("输入无效被拒绝，什么都不保存：%s", async (_name, over) => {
    const s = await setup();
    await expect(events().create(s.user.id, s.person.id, { ...MEET, ...over })).rejects.toBeInstanceOf(ValidationError);
    expect(await ctx.db.offlineEvent.count({ where: { personId: s.person.id } })).toBe(0);
  });

  it("按北京时间的“今天”判断是否是未来：今天的事件可以记录", async () => {
    const s = await setup();
    await expect(events().create(s.user.id, s.person.id, { ...MEET, occurredOn: "2026-04-10" })).resolves.toMatchObject({ revision: 1 });
  });

  it("列表按事件日期从新到旧", async () => {
    const s = await setup();
    const a = await events().create(s.user.id, s.person.id, { ...MEET, occurredOn: "2026-03-01" });
    const b = await events().create(s.user.id, s.person.id, { ...MEET, occurredOn: "2026-04-08", kind: "CALL" });
    expect((await events().list(s.user.id, s.person.id)).map((e) => e.id)).toEqual([b.id, a.id]);
  });
});

describe("修改线下事件", () => {
  it("修改事实（经过、日期或类型）产生新修订，旧修订保留", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);

    const edited = await events().update(s.user.id, e.id, { facts: "在咖啡店见面，聊了一个半小时。" });
    expect(edited).toMatchObject({ revision: 2, facts: "在咖啡店见面，聊了一个半小时。" });
    const dated = await events().update(s.user.id, e.id, { occurredOn: "2026-04-04" });
    expect(dated.revision).toBe(3);
    const typed = await events().update(s.user.id, e.id, { kind: "CALL" });
    expect(typed).toMatchObject({ revision: 4, kind: "CALL" });

    const revisions = await ctx.db.offlineEventRevision.findMany({ where: { eventId: e.id }, orderBy: { revision: "asc" } });
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(revisions[0]).toMatchObject({ kind: "MEET", facts: MEET.facts });
    expect(revisions[0].occurredOn.toISOString().slice(0, 10)).toBe("2026-04-05");
    expect(revisions[2].occurredOn.toISOString().slice(0, 10)).toBe("2026-04-04");
  });

  it("只改个人感受不产生新修订（感受不是证据，不会使报告过期）", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    const edited = await events().update(s.user.id, e.id, { personalNote: "现在回想，其实没那么紧张" });
    expect(edited).toMatchObject({ revision: 1, personalNote: "现在回想，其实没那么紧张", facts: MEET.facts });
    expect(await ctx.db.offlineEventRevision.count({ where: { eventId: e.id } })).toBe(1);

    const cleared = await events().update(s.user.id, e.id, { personalNote: "" });
    expect(cleared.personalNote).toBeNull();
    expect(cleared.revision).toBe(1);
  });

  it("提交的事实与当前相同：不产生修订；事实留空被拒绝，原事实不变", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    expect((await events().update(s.user.id, e.id, { facts: MEET.facts, kind: "MEET", occurredOn: "2026-04-05" })).revision).toBe(1);
    await expect(events().update(s.user.id, e.id, { facts: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(events().update(s.user.id, e.id, { occurredOn: "2099-01-01" })).rejects.toBeInstanceOf(ValidationError);
    expect((await events().list(s.user.id, s.person.id))[0]).toMatchObject({ revision: 1, facts: MEET.facts });
  });

  it("删除事件：事件与全部修订一并删除", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    await events().update(s.user.id, e.id, { facts: "改过一次" });
    await events().remove(s.user.id, e.id);
    expect(await ctx.db.offlineEvent.count({ where: { id: e.id } })).toBe(0);
    expect(await ctx.db.offlineEventRevision.count({ where: { eventId: e.id } })).toBe(0);
    await expect(events().remove(s.user.id, e.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("用户归属与对象删除", () => {
  it("B 不能读、改、删 A 的事件，也不能给 A 的对象添加事件；访问不属于自己的事件与不存在的表现一致", async () => {
    const a = await setup();
    const b = await makeUser(ctx.db);
    const e = await events().create(a.user.id, a.person.id, MEET);

    await expect(events().list(b.id, a.person.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(events().create(b.id, a.person.id, MEET)).rejects.toBeInstanceOf(NotFoundError);
    await expect(events().update(b.id, e.id, { facts: "被篡改" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(events().remove(b.id, e.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(events().update(b.id, "不存在的事件", { facts: "x" })).rejects.toBeInstanceOf(NotFoundError);

    expect(await ctx.db.offlineEvent.count({ where: { personId: a.person.id } })).toBe(1);
    expect((await events().list(a.user.id, a.person.id))[0]).toMatchObject({ facts: MEET.facts, revision: 1 });
  });

  it("删除对象：事件及其修订一并删除（不留下孤儿数据）", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    await events().update(s.user.id, e.id, { facts: "改过一次" });
    await people().remove(s.user.id, s.person.id);
    expect(await ctx.db.offlineEvent.count({ where: { personId: s.person.id } })).toBe(0);
    expect(await ctx.db.offlineEventRevision.count({ where: { eventId: e.id } })).toBe(0);
  });

  it("对象已被删除后，迟到的写入被拒绝", async () => {
    const s = await setup();
    const e = await events().create(s.user.id, s.person.id, MEET);
    await people().remove(s.user.id, s.person.id);
    await expect(events().create(s.user.id, s.person.id, MEET)).rejects.toBeInstanceOf(NotFoundError);
    await expect(events().update(s.user.id, e.id, { facts: "迟到" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
