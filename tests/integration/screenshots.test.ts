import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { makePng } from "../support/png";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createQuota, InsufficientQuotaError } from "@/server/quota/ledger";
import { createRecognition, type RecognitionJob } from "@/server/recognition/service";
import { createLocalStorage } from "@/server/storage/local";
import { createMockVision } from "@/server/ai/mock-vision";
import type { VisionModel } from "@/server/ai/vision";
import { NotFoundError, ValidationError } from "@/server/errors";
import { purgeOrphanFiles, purgeRevokedOriginals, purgeStaleBatches } from "@/server/maintenance";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let dir: string;
beforeAll(async () => {
  ctx = await newTestDb();
  dir = mkdtempSync(join(tmpdir(), "rel-shots-"));
});
afterAll(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const secret = "test-storage-signing-secret-0123456789";

/** 每个用例独立的服务装配：可替换的视觉模型、记录入队任务的假队列、可控时间。 */
function env(opts: { vision?: VisionModel } = {}) {
  let now = new Date();
  const jobs: RecognitionJob[] = [];
  const storage = createLocalStorage({ dir, secret, now: () => now });
  const quota = createQuota(ctx.db, { now: () => now });
  const vision = { current: opts.vision ?? createMockVision() };
  const make = () => ({
    imports: createImports(ctx.db, { storage, quota, now: () => now }),
    rec: createRecognition(ctx.db, {
      storage,
      quota,
      vision: { recognize: (i) => vision.current.recognize(i) },
      queue: { enqueue: async (job) => void jobs.push(job) },
      now: () => now,
    }),
  });
  const first = make();
  return {
    ...first,
    make,
    storage,
    quota,
    vision,
    jobs,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    setNow: (d: Date) => (now = d),
    drain: async (rec = first.rec) => {
      while (jobs.length) await rec.processScreenshot(jobs.shift()!);
    },
  };
}

const people = () => createPeople(ctx.db);
let seq = 0;
/** 一个用户 + 一个对象 + 一个截图批次 */
async function setup(e: ReturnType<typeof env>) {
  const user = await makeUser(ctx.db);
  const person = await people().create(user.id, { nickname: `阿青${seq++}` });
  const batch = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
  return { user, person, batch };
}

let uniq = 0;
const shot = (lines: string[]) => ({ name: `shot-${uniq++}.png`, bytes: makePng(lines.join("\n")) });
async function add(e: ReturnType<typeof env>, userId: string, batchId: string, lines: string[]) {
  const r = await e.rec.addScreenshot(userId, batchId, shot(lines));
  if (r.status !== "added") throw new Error("应当添加成功");
  return r.id;
}
const available = (e: ReturnType<typeof env>, userId: string) => e.quota.getAvailable(userId, "SCREENSHOT");

describe("上传截图", () => {
  it("添加后保存在私有存储（key 含用户与批次），批次保持“待提交”，不消耗额度", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const id = await add(e, user.id, batch.id, ["阿青：在吗", "我：在"]);
    const list = await e.rec.list(user.id, batch.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, idx: 0, status: "UPLOADED", contentType: "image/png" });
    const row = await ctx.db.screenshot.findUniqueOrThrow({ where: { id } });
    expect(row.storageKey).toContain(user.id);
    expect(row.storageKey).toContain(batch.id);
    expect(await e.storage.get(row.storageKey)).not.toBeNull();
    expect((await e.imports.getPreview(user.id, batch.id)).batch.status).toBe("UPLOADING");
    expect(await available(e, user.id)).toBe(120);
  });

  it("只接受 PNG/JPEG/WebP：按文件头判断，改了扩展名或声明类型的其他文件被拒绝", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const bad = [
      { name: "a.png", bytes: new Uint8Array(Buffer.from("GIF89a....")) },
      { name: "b.png", bytes: new Uint8Array(Buffer.from("%PDF-1.4 hello")) },
      { name: "c.png", bytes: new Uint8Array(Buffer.from("just text")) },
      { name: "d.png", bytes: new Uint8Array(0) },
    ];
    for (const f of bad) await expect(e.rec.addScreenshot(user.id, batch.id, f)).rejects.toBeInstanceOf(ValidationError);
    expect(await e.rec.list(user.id, batch.id)).toEqual([]);
    expect(await ctx.db.screenshot.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it("单张超过大小上限被拒绝", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const big = new Uint8Array(8_000_001);
    big.set(makePng("阿青：大"), 0);
    await expect(e.rec.addScreenshot(user.id, batch.id, { name: "big.png", bytes: big })).rejects.toBeInstanceOf(ValidationError);
  });

  it("单批最多 30 张，第 31 张被拒绝", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    for (let i = 0; i < 30; i++) await add(e, user.id, batch.id, [`阿青：第${i}句`]);
    await expect(e.rec.addScreenshot(user.id, batch.id, shot(["阿青：多出来的"]))).rejects.toBeInstanceOf(ValidationError);
    expect(await e.rec.list(user.id, batch.id)).toHaveLength(30);
  });

  it("相同文件重复上传：提示并跳过，不重复存储；同一对象的其他批次（含已保存）也能查出", async () => {
    const e = env();
    const { user, person, batch } = await setup(e);
    const f = shot(["阿青：重复内容", "我：好"]);
    expect((await e.rec.addScreenshot(user.id, batch.id, f)).status).toBe("added");
    const again = await e.rec.addScreenshot(user.id, batch.id, { name: "copy.png", bytes: f.bytes });
    expect(again).toMatchObject({ status: "duplicate" });
    expect(await ctx.db.screenshot.count({ where: { batchId: batch.id } })).toBe(1);

    const other = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
    expect((await e.rec.addScreenshot(user.id, other.id, { name: "again.png", bytes: f.bytes })).status).toBe("duplicate");
  });

  it("提交识别后不能再添加或移除截图；未提交时可移除，并删除存储文件", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const a = await add(e, user.id, batch.id, ["阿青：一"]);
    const b = await add(e, user.id, batch.id, ["阿青：二"]);
    const key = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id: a } })).storageKey;
    await e.rec.removeScreenshot(user.id, a);
    expect(await e.storage.get(key)).toBeNull();
    expect((await e.rec.list(user.id, batch.id)).map((s) => s.id)).toEqual([b]);

    await e.rec.start(user.id, batch.id);
    await expect(e.rec.addScreenshot(user.id, batch.id, shot(["阿青：晚了"]))).rejects.toBeInstanceOf(ValidationError);
    await expect(e.rec.removeScreenshot(user.id, b)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("开始识别与额度", () => {
  it("用户点“开始识别”才提交：按张预留额度并入队；没有截图不能开始", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await expect(e.rec.start(user.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await add(e, user.id, batch.id, ["阿青：二"]);
    await add(e, user.id, batch.id, ["阿青：三"]);
    expect(e.jobs).toHaveLength(0); // 上传不会自动识别
    expect(await e.rec.start(user.id, batch.id)).toEqual({ queued: 3 });
    expect(e.jobs).toHaveLength(3);
    expect(await available(e, user.id)).toBe(117);
    expect((await e.rec.getProgress(user.id, batch.id)).status).toBe("RECOGNIZING");
    await expect(e.rec.start(user.id, batch.id)).rejects.toBeInstanceOf(ValidationError); // 不能重复提交
    expect(e.jobs).toHaveLength(3);
  });

  it("额度不足时拒绝，状态与额度都不变，也不入队", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await add(e, user.id, batch.id, ["阿青：二"]);
    await e.quota.reserve(user.id, "SCREENSHOT", 119, "other-task"); // 只剩 1 张
    await expect(e.rec.start(user.id, batch.id)).rejects.toBeInstanceOf(InsufficientQuotaError);
    expect(e.jobs).toHaveLength(0);
    expect(await available(e, user.id)).toBe(1);
    expect((await e.rec.getProgress(user.id, batch.id)).status).toBe("UPLOADING");
  });
});

describe("识别、整合与确认", () => {
  it("全部成功：按上传顺序整合为暂存消息，截图之间重叠的部分只保留一份，额度按张结算", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：今晚吃什么", "我：火锅怎么样", "阿青：好呀", "我：七点见"]);
    await add(e, user.id, batch.id, ["阿青：好呀", "我：七点见", "阿青：不见不散", "我：我到了"]); // 与上一张重叠两条
    await e.rec.start(user.id, batch.id);
    await e.drain();

    const p = await e.imports.getPreview(user.id, batch.id);
    expect(p.batch.status).toBe("PENDING_CONFIRM");
    expect(p.messages.map((m) => m.content)).toEqual(["今晚吃什么", "火锅怎么样", "好呀", "七点见", "不见不散", "我到了"]);
    expect(p.messages.every((m) => m.speaker === "UNKNOWN")).toBe(true); // 身份仍需用户确认
    expect(await available(e, user.id)).toBe(118);
    expect(await ctx.db.quotaEntry.count({ where: { userId: user.id, kind: "SCREENSHOT", type: "SETTLE" } })).toBe(1);

    const progress = await e.rec.getProgress(user.id, batch.id);
    expect(progress).toMatchObject({ total: 2, done: 2, failed: 0, running: 0, finished: true });
  });

  it("保留真实的连续重复发言：不同截图里各一条“在”不会被当作重叠", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：在吗", "我：在"]);
    await add(e, user.id, batch.id, ["我：在", "阿青：哈哈"]);
    await e.rec.start(user.id, batch.id);
    await e.drain();
    expect((await e.imports.getPreview(user.id, batch.id)).messages.map((m) => m.content)).toEqual(["在吗", "在", "在", "哈哈"]);
  });

  it("识别出的不确定内容进入集中处理；确认身份、处理后保存，原图立即不可再访问", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const id = await add(e, user.id, batch.id, ["阿青：你好", "???", "我：在"]);
    const token = await e.rec.signedUrl(user.id, id);
    expect((await e.rec.open(user.id, token)).bytes.length).toBeGreaterThan(0);

    await e.rec.start(user.id, batch.id);
    await e.drain();
    let p = await e.imports.getPreview(user.id, batch.id);
    expect(p.uncertainCount).toBe(1);
    expect(p.messages.find((m) => m.recognition === "UNCERTAIN")?.content).toBe("???");
    // 确认前原图仍可查看，便于核对
    expect((await e.rec.open(user.id, token)).contentType).toBe("image/png");

    await e.imports.discardMessage(user.id, p.messages[1].id);
    await e.imports.setLabelRole(user.id, batch.id, "阿青", "OTHER");
    await e.imports.setLabelRole(user.id, batch.id, "我", "SELF");
    expect(await e.imports.confirm(user.id, batch.id)).toEqual({ saved: 2, merged: 0 });

    await expect(e.rec.open(user.id, token)).rejects.toBeInstanceOf(NotFoundError); // 旧链接立即失效
    await expect(e.rec.signedUrl(user.id, id)).rejects.toBeInstanceOf(NotFoundError);
    p = await e.imports.getPreview(user.id, batch.id);
    expect(p.batch.status).toBe("CONFIRMED");
    expect((await e.imports.listMessages(user.id, batch.id)).map((m) => m.content)).toEqual(["你好", "在"]);
  });

  it("识别结果复用跨批次去重：与已保存聊天重叠时提示", async () => {
    const e = env();
    const { user, person, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：今晚吃什么", "我：火锅怎么样", "阿青：好呀"]);
    await e.rec.start(user.id, batch.id);
    await e.drain();
    await e.imports.setLabelRole(user.id, batch.id, "阿青", "OTHER");
    await e.imports.setLabelRole(user.id, batch.id, "我", "SELF");
    await e.imports.confirm(user.id, batch.id);

    const b2 = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
    await add(e, user.id, b2.id, ["我：火锅怎么样", "阿青：好呀", "我：七点见"]);
    await e.rec.start(user.id, b2.id);
    await e.drain();
    const p = await e.imports.getPreview(user.id, b2.id);
    expect(p.overlapCount).toBe(2);
    expect(p.labels).toEqual([
      { label: "我", count: 2, role: "SELF" },
      { label: "阿青", count: 1, role: "OTHER" },
    ]); // 按上次设置预填，仍需确认
    expect(p.canConfirm).toBe(false);
  });
});

describe("失败、重试与进度恢复", () => {
  it("部分失败：成功的保留，额度只按成功张数结算；失败的可单独重试且不重复扣减", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一", "我：二"]);
    const bad = await add(e, user.id, batch.id, ["阿青：三", "[[FAIL]]"]);
    await add(e, user.id, batch.id, ["我：四", "阿青：五"]);
    await e.rec.start(user.id, batch.id);
    await e.drain();

    let progress = await e.rec.getProgress(user.id, batch.id);
    expect(progress).toMatchObject({ status: "RECOGNIZING", done: 2, failed: 1, running: 0, finished: true, canRetry: true, canSkip: true });
    expect((await e.rec.list(user.id, batch.id)).find((s) => s.id === bad)).toMatchObject({ status: "FAILED", errorCode: "RECOGNITION_FAILED" });
    expect(await available(e, user.id)).toBe(118); // 预留 3，成功 2，退还 1
    expect((await e.imports.getPreview(user.id, batch.id)).messages).toEqual([]); // 还没整合，等失败项处理完

    // 修复后重试这一张（换成不会失败的内容）：只为这一张新预留 1
    e.vision.current = { recognize: async () => ({ messages: [{ line: 1, speakerLabel: "阿青", content: "三", type: "TEXT", occurredAt: null, timePrecision: "UNKNOWN", uncertain: false }] }) };
    expect(await e.rec.retryFailed(user.id, batch.id)).toEqual({ queued: 1 });
    expect(await available(e, user.id)).toBe(117);
    await e.drain();
    progress = await e.rec.getProgress(user.id, batch.id);
    expect(progress).toMatchObject({ status: "PENDING_CONFIRM", done: 3, failed: 0, finished: true });
    expect(await available(e, user.id)).toBe(117); // 三张，每张只扣一次
    expect((await e.imports.getPreview(user.id, batch.id)).messages.length).toBeGreaterThanOrEqual(3);
  });

  it("全部失败：额度全部退还；没有可用结果时不能“跳过失败项”", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一", "[[FAIL]]"]);
    await add(e, user.id, batch.id, ["阿青：二", "[[FAIL]]"]);
    await e.rec.start(user.id, batch.id);
    await e.drain();
    expect(await available(e, user.id)).toBe(120);
    expect(await e.rec.getProgress(user.id, batch.id)).toMatchObject({ failed: 2, done: 0, canRetry: true });
    await expect(e.rec.skipFailed(user.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("跳过失败项：用成功的结果继续，被跳过的不计费", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一", "我：二"]);
    await add(e, user.id, batch.id, ["阿青：三", "[[FAIL]]"]);
    await e.rec.start(user.id, batch.id);
    await e.drain();
    await e.rec.skipFailed(user.id, batch.id);
    const p = await e.imports.getPreview(user.id, batch.id);
    expect(p.batch.status).toBe("PENDING_CONFIRM");
    expect(p.messages.map((m) => m.content)).toEqual(["一", "二"]);
    expect(await available(e, user.id)).toBe(119);
    expect((await e.rec.getProgress(user.id, batch.id)).skipped).toBe(1);
  });

  it("刷新/重启后进度仍在：新的服务实例读到同样的进度，识别中的任务不受影响", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await add(e, user.id, batch.id, ["阿青：二"]);
    await e.rec.start(user.id, batch.id);
    await e.rec.processScreenshot(e.jobs.shift()!); // 只处理了一张
    const restarted = e.make().rec;
    expect(await restarted.getProgress(user.id, batch.id)).toMatchObject({ status: "RECOGNIZING", total: 2, done: 1, queued: 1, finished: false });
    await e.drain(restarted);
    expect((await restarted.getProgress(user.id, batch.id)).status).toBe("PENDING_CONFIRM");
  });

  it("同一任务被重复投递只处理一次", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await e.rec.start(user.id, batch.id);
    const job = e.jobs.shift()!;
    await Promise.all([e.rec.processScreenshot(job), e.rec.processScreenshot(job)]);
    await e.rec.processScreenshot(job);
    expect((await e.imports.getPreview(user.id, batch.id)).messages).toHaveLength(1);
    expect(await available(e, user.id)).toBe(119);
  });

  it("卡住的识别（超过 15 分钟没有结果）被判为失败并退还额度", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await e.rec.start(user.id, batch.id);
    e.jobs.length = 0; // 模拟 worker 崩溃：任务丢失
    expect(await e.rec.getProgress(user.id, batch.id)).toMatchObject({ queued: 1 });
    await e.rec.sweepStuck(); // 还没超时：不动
    expect(await e.rec.getProgress(user.id, batch.id)).toMatchObject({ queued: 1, failed: 0 });
    e.advance(16 * 60_000);
    expect(await e.rec.sweepStuck()).toBeGreaterThanOrEqual(1); // 清理是全局的，同库的其他用例也可能被扫到
    expect(await e.rec.getProgress(user.id, batch.id)).toMatchObject({ failed: 1, running: 0, finished: true });
    expect(await available(e, user.id)).toBe(120);
  });
});

describe("批次删除与删除围栏", () => {
  it("识别前删除批次：文件与额度一并清理；之后到达的任务不会写回，也不会再次退还", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const id = await add(e, user.id, batch.id, ["阿青：一"]);
    const key = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id } })).storageKey;
    await e.rec.start(user.id, batch.id);
    expect(await available(e, user.id)).toBe(119);

    await e.imports.deleteBatch(user.id, batch.id);
    expect(await available(e, user.id)).toBe(120);
    expect(await e.storage.get(key)).toBeNull();
    await e.drain(); // 迟到的任务：安静退出
    expect(await available(e, user.id)).toBe(120);
    expect(await ctx.db.message.count({ where: { batchId: batch.id } })).toBe(0);
    expect(await ctx.db.screenshot.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it("识别进行中删除批次：运行中的任务完成后不能写回，额度已退还", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await e.rec.start(user.id, batch.id);
    e.vision.current = {
      recognize: async () => {
        await e.imports.deleteBatch(user.id, batch.id); // 识别期间用户删除了批次
        return { messages: [{ line: 1, speakerLabel: "阿青", content: "一", type: "TEXT", occurredAt: null, timePrecision: "UNKNOWN", uncertain: false }] };
      },
    };
    await e.drain();
    expect(await ctx.db.message.count({ where: { batchId: batch.id } })).toBe(0);
    expect(await available(e, user.id)).toBe(120);
    expect(await ctx.db.quotaEntry.count({ where: { userId: user.id, type: "SETTLE" } })).toBe(0);
  });

  it("删除对象后，迟到的识别任务同样不能写回", async () => {
    const e = env();
    const { user, person, batch } = await setup(e);
    await add(e, user.id, batch.id, ["阿青：一"]);
    await e.rec.start(user.id, batch.id);
    await people().remove(user.id, person.id);
    await e.drain();
    expect(await ctx.db.message.count({ where: { personId: person.id } })).toBe(0);
  });
});

describe("原图清理", () => {
  it("确认保存后文件由清理任务物理删除（行保留哈希用于查重）", async () => {
    const e = env();
    const { user, person, batch } = await setup(e);
    const f = shot(["阿青：你好", "我：在"]);
    const added = await e.rec.addScreenshot(user.id, batch.id, f);
    if (added.status !== "added") throw new Error();
    const key = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id: added.id } })).storageKey;
    await e.rec.start(user.id, batch.id);
    await e.drain();
    await e.imports.setLabelRole(user.id, batch.id, "阿青", "OTHER");
    await e.imports.setLabelRole(user.id, batch.id, "我", "SELF");
    await e.imports.confirm(user.id, batch.id);

    expect(await e.storage.get(key)).not.toBeNull(); // 已停止访问，但物理文件要等清理任务
    expect((await purgeRevokedOriginals(ctx.db, e.storage, new Date())).files).toBeGreaterThanOrEqual(1); // 全局清理，同库其他用例的也会被删
    expect(await e.storage.get(key)).toBeNull();
    const row = await ctx.db.screenshot.findUniqueOrThrow({ where: { id: added.id } });
    expect(row.purgedAt).not.toBeNull();
    expect(await purgeRevokedOriginals(ctx.db, e.storage, new Date())).toEqual({ files: 0 });

    const b2 = await e.imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
    expect((await e.rec.addScreenshot(user.id, b2.id, f)).status).toBe("duplicate"); // 原图已删，仍能识别出重复上传
  });

  it("超过 7 天未确认的批次：文件与记录一并清理；已保存与较新的不受影响", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const stale = await add(e, user.id, batch.id, ["阿青：陈旧的"]);
    const staleKey = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id: stale } })).storageKey;
    await ctx.db.importBatch.update({ where: { id: batch.id }, data: { createdAt: new Date(Date.now() - 8 * 86400_000) } });

    const fresh = await e.imports.createBatch(user.id, (await ctx.db.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).personId, {
      platform: "WECHAT",
      dataKind: "CONTINUOUS",
      sourceKind: "SCREENSHOT",
    });
    const freshId = await add(e, user.id, fresh.id, ["阿青：新鲜的"]);
    const freshKey = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id: freshId } })).storageKey;

    expect((await purgeStaleBatches(ctx.db, new Date(), e.storage)).batches).toBe(1);
    expect(await e.storage.get(staleKey)).toBeNull();
    expect(await e.storage.get(freshKey)).not.toBeNull();
  });

  it("孤儿文件（没有对应记录、超过 1 小时）被清理；较新的与有记录的保留", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const id = await add(e, user.id, batch.id, ["阿青：有记录的"]);
    const liveKey = (await ctx.db.screenshot.findUniqueOrThrow({ where: { id } })).storageKey;
    await e.storage.put("u/ghost/b/orphan-old", new Uint8Array([1]), "image/png");
    await e.storage.put("u/ghost/b/orphan-new", new Uint8Array([2]), "image/png");
    const later = new Date(Date.now() + 2 * 3600_000);
    // 只让“旧”孤儿超过 1 小时：把检查时间推后，再重新写入“新”孤儿
    await purgeOrphanFiles(ctx.db, e.storage, later);
    expect(await e.storage.get("u/ghost/b/orphan-old")).toBeNull();
    expect(await e.storage.get(liveKey)).not.toBeNull();
    await e.storage.put("u/ghost/b/orphan-new2", new Uint8Array([3]), "image/png");
    await purgeOrphanFiles(ctx.db, e.storage, new Date());
    expect(await e.storage.get("u/ghost/b/orphan-new2")).not.toBeNull();
  });
});

describe("用户归属与签名链接", () => {
  it("B 无法操作 A 的批次与截图：上传、识别、进度、重试、查看原图一律 404", async () => {
    const e = env();
    const a = await setup(e);
    const b = await makeUser(ctx.db);
    const id = await add(e, a.user.id, a.batch.id, ["阿青：秘密"]);
    const token = await e.rec.signedUrl(a.user.id, id);

    await expect(e.rec.addScreenshot(b.id, a.batch.id, shot(["阿青：入侵"]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.list(b.id, a.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.getProgress(b.id, a.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.start(b.id, a.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.retryFailed(b.id, a.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.skipFailed(b.id, a.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.removeScreenshot(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.signedUrl(b.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.open(b.id, token)).rejects.toBeInstanceOf(NotFoundError); // 拿到 A 的链接也不行
    expect((await e.rec.open(a.user.id, token)).bytes.length).toBeGreaterThan(0);
    expect(await e.rec.list(a.user.id, a.batch.id)).toHaveLength(1);
  });

  it("签名链接过期或被篡改后拒绝", async () => {
    const e = env();
    const { user, batch } = await setup(e);
    const id = await add(e, user.id, batch.id, ["阿青：链接"]);
    const token = await e.rec.signedUrl(user.id, id);
    const [payload, sig] = token.split(".");
    await expect(e.rec.open(user.id, `${payload}.${sig.slice(0, -2)}AA`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(e.rec.open(user.id, "garbage")).rejects.toBeInstanceOf(NotFoundError);
    e.advance(6 * 60_000); // 默认有效期 5 分钟
    await expect(e.rec.open(user.id, token)).rejects.toBeInstanceOf(NotFoundError);
    expect((await e.rec.open(user.id, await e.rec.signedUrl(user.id, id))).bytes.length).toBeGreaterThan(0);
  });
});
