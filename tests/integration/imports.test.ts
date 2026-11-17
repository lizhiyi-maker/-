import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { NotFoundError, ValidationError } from "@/server/errors";
import { purgeStaleBatches } from "@/server/maintenance";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let imports: ReturnType<typeof createImports>;
let people: ReturnType<typeof createPeople>;
beforeAll(async () => {
  ctx = await newTestDb();
  imports = createImports(ctx.db);
  people = createPeople(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

const sample = (name: string) => readFileSync(join(process.cwd(), "samples", "chat-text", name), "utf8");

async function setup() {
  const user = await makeUser(ctx.db);
  const person = await people.create(user.id, { nickname: "阿青" });
  return { user, person };
}

/** 新建批次并提交文本，返回批次 ID */
async function submit(userId: string, personId: string, text: string, dataKind: "CONTINUOUS" | "CURATED" | "UNCERTAIN" = "CONTINUOUS") {
  const batch = await imports.createBatch(userId, personId, { platform: "WECHAT", dataKind });
  await imports.submitText(userId, batch.id, text);
  return batch.id;
}

async function confirmAll(userId: string, batchId: string, roles: Record<string, "SELF" | "OTHER">) {
  for (const [label, role] of Object.entries(roles)) await imports.setLabelRole(userId, batchId, label, role);
  return imports.confirm(userId, batchId);
}

describe("提交与确认流程", () => {
  it("提交文本后进入待确认：消息为暂存状态，发言人未确认，不能保存", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    const p = await imports.getPreview(user.id, id);
    expect(p.batch.status).toBe("PENDING_CONFIRM");
    expect(p.messages).toHaveLength(4);
    expect(p.messages.every((m) => m.speaker === "UNKNOWN")).toBe(true);
    expect(p.labels).toEqual([
      { label: "阿青", count: 2, role: null },
      { label: "我", count: 2, role: null },
    ]);
    expect(p.canConfirm).toBe(false);
    expect(p.blockers.join()).toContain("我");
    await expect(imports.confirm(user.id, id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("确认前的暂存消息不属于正式聊天资料", async () => {
    const { user, person } = await setup();
    await submit(user.id, person.id, sample("inline-no-time.txt"));
    expect(await imports.listBatches(user.id, person.id)).toEqual([]);
    expect((await imports.listPending(user.id)).map((b) => b.personId)).toContain(person.id);
  });

  it("用户确认“我/对方”并保存：按原顺序保存，未知时间保持未知，不被猜测", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    const r = await confirmAll(user.id, id, { 我: "SELF", 阿青: "OTHER" });
    expect(r).toEqual({ saved: 4, merged: 0 });

    const rows = await imports.listMessages(user.id, id);
    expect(rows.map((m) => [m.speaker, m.content])).toEqual([
      ["OTHER", "在吗"],
      ["SELF", "在"],
      ["SELF", "在"], // 真实的连续重复发言被保留
      ["OTHER", "哈哈"],
    ]);
    expect(rows.every((m) => m.occurredAt === null && m.timePrecision === "UNKNOWN")).toBe(true);
    const batches = await imports.listBatches(user.id, person.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ status: "CONFIRMED", messageCount: 4, dataKind: "CONTINUOUS" });
    expect(await imports.listPending(user.id)).toEqual([]);
  });

  it("保留真实时间与精度；多行消息、图片占位按原样保存", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("header-style.txt"));
    await confirmAll(user.id, id, { 我: "SELF", 小林: "OTHER" });
    const rows = await imports.listMessages(user.id, id);
    expect(rows[0].occurredAt?.toISOString()).toBe("2026-03-01T12:15:03.000Z");
    expect(rows[0].timePrecision).toBe("SECOND");
    expect(rows[3]).toMatchObject({ type: "IMAGE", content: "[图片]" });
    expect(rows[4].content).toBe("可以\n周六六点见");
  });

  it("已确认或已有内容的批次不能重复提交；粘贴超过 2 万字或没有任何消息会被拒绝", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    await expect(imports.submitText(user.id, id, "阿青：再来一段")).rejects.toBeInstanceOf(ValidationError);

    const b2 = await imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" });
    await expect(imports.submitText(user.id, b2.id, `阿青：${"字".repeat(20_001)}`)).rejects.toBeInstanceOf(ValidationError);
    await expect(imports.submitText(user.id, b2.id, "   \n  ")).rejects.toBeInstanceOf(ValidationError);
    expect((await imports.getPreview(user.id, b2.id)).batch.status).toBe("UPLOADING");
  });
});

describe("确认与纠错", () => {
  it("批内交换发言人：返回受影响的消息数，并视为用户已确认身份", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    await expect(imports.swapSpeakers(user.id, id)).rejects.toBeInstanceOf(ValidationError); // 还没有可交换的身份
    await imports.setLabelRole(user.id, id, "我", "SELF");
    await imports.setLabelRole(user.id, id, "阿青", "OTHER");
    const r = await imports.swapSpeakers(user.id, id);
    expect(r.swappedMessages).toBe(4);
    const p = await imports.getPreview(user.id, id);
    expect(p.labels).toEqual([
      { label: "阿青", count: 2, role: "SELF" },
      { label: "我", count: 2, role: "OTHER" },
    ]);
    expect(p.messages.map((m) => m.speaker)).toEqual(["SELF", "OTHER", "OTHER", "SELF"]);
    expect(p.canConfirm).toBe(true);
  });

  it("编辑文字产生新修订并保留旧修订；时间可改为未知，可靠时间必须带具体时间", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    const first = (await imports.getPreview(user.id, id)).messages[0];
    await imports.editMessage(user.id, first.id, { content: "在吗？" });
    await imports.editMessage(user.id, first.id, { content: "在吗？？" });
    const revs = await imports.listRevisions(user.id, first.id);
    expect(revs.map((r) => [r.revision, r.content])).toEqual([
      [1, "在吗"],
      [2, "在吗？"],
      [3, "在吗？？"],
    ]);
    const edited = (await imports.getPreview(user.id, id)).messages[0];
    expect(edited).toMatchObject({ content: "在吗？？", recognition: "USER_EDITED" });

    await imports.editMessage(user.id, first.id, { occurredAt: new Date("2026-03-01T12:00:00Z"), timePrecision: "MINUTE" });
    expect((await imports.getPreview(user.id, id)).messages[0]).toMatchObject({ timePrecision: "MINUTE" });
    await imports.editMessage(user.id, first.id, { timePrecision: "UNKNOWN" });
    expect((await imports.getPreview(user.id, id)).messages[0]).toMatchObject({ occurredAt: null, timePrecision: "UNKNOWN" });
    await expect(imports.editMessage(user.id, first.id, { timePrecision: "MINUTE" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("不确定内容集中处理：未处理前不能保存；可编辑指定发言人、按原样保留或丢弃", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("uncertain-lines.txt"));
    await imports.setLabelRole(user.id, id, "我", "SELF");
    await imports.setLabelRole(user.id, id, "阿青", "OTHER");
    let p = await imports.getPreview(user.id, id);
    expect(p.uncertainCount).toBe(2);
    expect(p.canConfirm).toBe(false);
    await expect(imports.confirm(user.id, id)).rejects.toBeInstanceOf(ValidationError);

    const [stray1, , stray2] = p.messages;
    await imports.editMessage(user.id, stray1.id, { speaker: "OTHER" }); // 指定发言人即视为已处理
    await imports.discardMessage(user.id, stray2.id);
    p = await imports.getPreview(user.id, id);
    expect(p.uncertainCount).toBe(0);
    expect(p.canConfirm).toBe(true);
    expect(await imports.confirm(user.id, id)).toEqual({ saved: 3, merged: 0 });
  });

  it("按原样保留不确定内容后可保存，发言人仍为未知（不猜测）", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, "阿青：你好\n???\n我：在");
    const p = await imports.getPreview(user.id, id);
    await imports.acceptMessage(user.id, p.messages[1].id);
    await confirmAll(user.id, id, { 我: "SELF", 阿青: "OTHER" });
    const rows = await imports.listMessages(user.id, id);
    expect(rows[1]).toMatchObject({ speaker: "UNKNOWN", content: "???" });
  });

  it("后续批次按上次设置预填“我/对方”，但仍需用户确认后才能保存", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, "阿青：在吗\n我：在");
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });

    const b2 = await submit(user.id, person.id, "阿青：吃了吗\n我：吃了");
    const p = await imports.getPreview(user.id, b2);
    expect(p.labels.map((l) => l.role)).toEqual(["OTHER", "SELF"]);
    expect(p.canConfirm).toBe(false);
    await expect(imports.confirm(user.id, b2)).rejects.toBeInstanceOf(ValidationError);
    await imports.confirmIdentity(user.id, b2);
    expect(await imports.confirm(user.id, b2)).toEqual({ saved: 2, merged: 0 });
  });

  it("资料类型可在导入时选择，也可在保存前后修改", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, "阿青：在吗\n我：在", "CURATED");
    expect((await imports.getPreview(user.id, id)).batch.dataKind).toBe("CURATED");
    await imports.setDataKind(user.id, id, "UNCERTAIN");
    await confirmAll(user.id, id, { 我: "SELF", 阿青: "OTHER" });
    await imports.setDataKind(user.id, id, "CONTINUOUS");
    expect((await imports.listBatches(user.id, person.id))[0].dataKind).toBe("CONTINUOUS");
  });
});

describe("重叠与跨批次去重", () => {
  const first = "阿青：今晚吃什么\n我：火锅怎么样\n阿青：好呀\n我：七点见\n阿青：不见不散";

  it("新批次与已保存资料重叠：默认合并，只保存新增的消息", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, first);
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });

    const b2 = await submit(user.id, person.id, "我：七点见\n阿青：不见不散\n我：我到了\n阿青：马上");
    await imports.setLabelRole(user.id, b2, "我", "SELF");
    await imports.setLabelRole(user.id, b2, "阿青", "OTHER");
    const p = await imports.getPreview(user.id, b2);
    expect(p.overlapCount).toBe(2);
    expect(p.messages.map((m) => m.duplicateOfId !== null)).toEqual([true, true, false, false]);

    expect(await imports.confirm(user.id, b2)).toEqual({ saved: 2, merged: 2 });
    expect((await imports.listMessages(user.id, b2)).map((m) => m.content)).toEqual(["我到了", "马上"]);
  });

  it("用户选择全部保留时不合并", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, first);
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });
    const b2 = await submit(user.id, person.id, "我：七点见\n阿青：不见不散");
    await imports.setLabelRole(user.id, b2, "我", "SELF");
    await imports.setLabelRole(user.id, b2, "阿青", "OTHER");
    expect(await imports.confirm(user.id, b2, { keepOverlap: true })).toEqual({ saved: 2, merged: 0 });
  });

  it("重复上传同一段：全部识别为重复；单独一条相同的发言不被当作重复", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, "阿青：在吗\n我：在");
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });

    const dup = await submit(user.id, person.id, "阿青：在吗\n我：在");
    await imports.setLabelRole(user.id, dup, "我", "SELF");
    await imports.setLabelRole(user.id, dup, "阿青", "OTHER");
    expect((await imports.getPreview(user.id, dup)).overlapCount).toBe(2);

    const lone = await submit(user.id, person.id, "我：在\n我：在\n我：在");
    await imports.setLabelRole(user.id, lone, "我", "SELF");
    expect((await imports.getPreview(user.id, lone)).overlapCount).toBe(0);
  });

  it("交换发言人后重叠按新的身份重新判断", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, first);
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });
    const b2 = await submit(user.id, person.id, "我：七点见\n阿青：不见不散");
    await imports.setLabelRole(user.id, b2, "我", "OTHER"); // 故意设反
    await imports.setLabelRole(user.id, b2, "阿青", "SELF");
    expect((await imports.getPreview(user.id, b2)).overlapCount).toBe(0);
    const r = await imports.swapSpeakers(user.id, b2);
    expect(r.overlapAfter).toBe(2);
    expect((await imports.getPreview(user.id, b2)).overlapCount).toBe(2);
  });

  it("不同对象之间的资料互不比较", async () => {
    const { user, person } = await setup();
    const other = await people.create(user.id, { nickname: "另一个人" });
    const b1 = await submit(user.id, person.id, first);
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });
    const b2 = await submit(user.id, other.id, "我：七点见\n阿青：不见不散");
    await imports.setLabelRole(user.id, b2, "我", "SELF");
    await imports.setLabelRole(user.id, b2, "阿青", "OTHER");
    expect((await imports.getPreview(user.id, b2)).overlapCount).toBe(0);
  });
});

describe("用户归属", () => {
  it("B 无法访问或修改 A 的批次与消息，也不能向 A 的对象导入", async () => {
    const a = await setup();
    const b = await makeUser(ctx.db);
    const id = await submit(a.user.id, a.person.id, sample("inline-no-time.txt"));
    const msg = (await imports.getPreview(a.user.id, id)).messages[0];
    await confirmAll(a.user.id, id, { 我: "SELF", 阿青: "OTHER" });

    await expect(imports.createBatch(b.id, a.person.id, { platform: "WECHAT", dataKind: "CONTINUOUS" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.getPreview(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.setLabelRole(b.id, id, "我", "OTHER")).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.swapSpeakers(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.confirmIdentity(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.editMessage(b.id, msg.id, { content: "篡改" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.acceptMessage(b.id, msg.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.discardMessage(b.id, msg.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.listRevisions(b.id, msg.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.setDataKind(b.id, id, "CURATED")).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.confirm(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.listMessages(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imports.deleteBatch(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await imports.listBatches(b.id, a.person.id)).toEqual([]);
    expect(await imports.listPending(b.id)).toEqual([]);

    const rows = await imports.listMessages(a.user.id, id);
    expect(rows.map((m) => m.content)).toEqual(["在吗", "在", "在", "哈哈"]);
  });
});

describe("删除与删除围栏", () => {
  it("删除批次：消息与修订一并删除，其他批次不受影响；依赖它的重叠标记被清除", async () => {
    const { user, person } = await setup();
    const b1 = await submit(user.id, person.id, "阿青：今晚吃什么\n我：火锅怎么样");
    await confirmAll(user.id, b1, { 我: "SELF", 阿青: "OTHER" });
    const b2 = await submit(user.id, person.id, "阿青：今晚吃什么\n我：火锅怎么样\n阿青：好呀");
    await imports.setLabelRole(user.id, b2, "我", "SELF");
    await imports.setLabelRole(user.id, b2, "阿青", "OTHER");
    expect((await imports.getPreview(user.id, b2)).overlapCount).toBe(2);

    await imports.deleteBatch(user.id, b1);
    expect(await ctx.db.message.count({ where: { batchId: b1 } })).toBe(0);
    expect(await ctx.db.messageRevision.count({ where: { message: { batchId: b1 } } })).toBe(0);
    await expect(imports.getPreview(user.id, b1)).rejects.toBeInstanceOf(NotFoundError);
    const p = await imports.getPreview(user.id, b2);
    expect(p.messages).toHaveLength(3);
    expect(p.overlapCount).toBe(0);
  });

  it("批次删除后，持有旧代际的后台任务不能写回，回调不会被执行", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, "阿青：在吗");
    const { generation } = (await imports.getPreview(user.id, id)).batch;
    await imports.deleteBatch(user.id, id);
    let wrote = false;
    await expect(
      imports.withLiveBatch(user.id, id, generation, async () => {
        wrote = true;
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(wrote).toBe(false);
  });

  it("任务写回与批次删除并发：写回要么在删除前完整完成，要么被拒绝", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, "阿青：在吗");
    const { generation } = (await imports.getPreview(user.id, id)).batch;
    const order: string[] = [];
    const task = imports.withLiveBatch(user.id, id, generation, async () => {
      await new Promise((r) => setTimeout(r, 300));
      order.push("task-written");
    });
    await new Promise((r) => setTimeout(r, 50));
    const del = imports.deleteBatch(user.id, id).then(() => order.push("deleted"));
    await Promise.all([task, del]);
    expect(order).toEqual(["task-written", "deleted"]);
  });

  it("删除对象会级联删除其批次、消息与修订", async () => {
    const { user, person } = await setup();
    const id = await submit(user.id, person.id, sample("inline-no-time.txt"));
    await confirmAll(user.id, id, { 我: "SELF", 阿青: "OTHER" });
    await people.remove(user.id, person.id);
    expect(await ctx.db.importBatch.count({ where: { personId: person.id } })).toBe(0);
    expect(await ctx.db.message.count({ where: { personId: person.id } })).toBe(0);
    expect(await ctx.db.messageRevision.count({ where: { message: { personId: person.id } } })).toBe(0);
  });
});

describe("未确认资料的清理", () => {
  it("超过 7 天仍未确认的批次连同暂存消息被清理；已确认的不受影响", async () => {
    const { user, person } = await setup();
    const stale = await submit(user.id, person.id, "阿青：旧的未确认");
    const kept = await submit(user.id, person.id, "阿青：已确认的\n我：好");
    await confirmAll(user.id, kept, { 我: "SELF", 阿青: "OTHER" });
    const fresh = await submit(user.id, person.id, "阿青：刚导入");
    const old = new Date(Date.now() - 8 * 86400_000);
    await ctx.db.importBatch.update({ where: { id: stale }, data: { createdAt: old } });
    await ctx.db.importBatch.update({ where: { id: kept }, data: { createdAt: old } });

    const r = await purgeStaleBatches(ctx.db, new Date());
    expect(r.batches).toBe(1);
    await expect(imports.getPreview(user.id, stale)).rejects.toBeInstanceOf(NotFoundError);
    expect((await imports.getPreview(user.id, fresh)).batch.status).toBe("PENDING_CONFIRM");
    expect((await imports.listBatches(user.id, person.id))[0].id).toBe(kept);
  });
});
