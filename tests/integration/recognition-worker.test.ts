import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { makeUser } from "../support/factories";
import { makePng } from "../support/png";
import { createMockVision } from "@/server/ai/mock-vision";
import { createConsent } from "@/server/consent/service";
import { createImports } from "@/server/imports/service";
import { createPeople } from "@/server/people/service";
import { createPgBossQueue } from "@/server/queue";
import { createQuota } from "@/server/quota/ledger";
import { createRecognition } from "@/server/recognition/service";
import { createLocalStorage } from "@/server/storage/local";
import { startWorker } from "@/worker/boss";

let ctx: Awaited<ReturnType<typeof newTestDb>>;
let dir: string;
beforeAll(async () => {
  ctx = await newTestDb();
  dir = mkdtempSync(join(tmpdir(), "rel-worker-shots-"));
});
afterAll(async () => {
  await ctx?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => Promise<T | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("识别任务经 pg-boss 由独立 worker 执行", () => {
  it("Web 侧提交后任务进入队列，worker 识别并整合；Web 侧仅凭数据库读到进度", async () => {
    const storage = createLocalStorage({ dir, secret: "test-storage-signing-secret-0123456789" });
    const quota = createQuota(ctx.db);
    const queue = createPgBossQueue(ctx.url);
    const consent = createConsent(ctx.db, { providerId: "mock" });
    const web = createRecognition(ctx.db, { storage, quota, queue, consent, vision: { recognize: async () => ({ messages: [] }) } }); // Web 进程不执行识别
    const workerRec = createRecognition(ctx.db, { storage, quota, queue, consent, vision: createMockVision() });
    const worker = await startWorker(ctx.url, undefined, { db: ctx.db, recognition: workerRec, storage });
    try {
      const imports = createImports(ctx.db, { storage, quota });
      const user = await makeUser(ctx.db);
      await consent.accept(user.id);
      const person = await createPeople(ctx.db).create(user.id, { nickname: "阿青" });
      const batch = await imports.createBatch(user.id, person.id, { platform: "WECHAT", dataKind: "CONTINUOUS", sourceKind: "SCREENSHOT" });
      for (const text of ["阿青：在吗\n我：在", "我：在\n阿青：周六有空吗"]) {
        await web.addScreenshot(user.id, batch.id, { name: "s.png", bytes: makePng(text) });
      }
      expect(await web.start(user.id, batch.id)).toEqual({ queued: 2 });

      const progress = await waitFor(async () => {
        const p = await web.getProgress(user.id, batch.id);
        return p.status === "PENDING_CONFIRM" && p;
      });
      expect(progress).toMatchObject({ done: 2, failed: 0, finished: true });
      expect((await imports.getPreview(user.id, batch.id)).messages.map((m) => m.content)).toEqual(["在吗", "在", "在", "周六有空吗"]);
      expect(await quota.getAvailable(user.id, "SCREENSHOT")).toBe(118);
    } finally {
      await queue.stop();
      await worker.stop();
    }
  });
});
