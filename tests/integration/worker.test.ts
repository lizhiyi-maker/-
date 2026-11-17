import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTestDb } from "../support/db";
import { createBoss, QUEUES, startWorker, type HeartbeatPayload } from "@/worker/boss";

let db: Awaited<ReturnType<typeof newTestDb>>;
beforeAll(async () => {
  db = await newTestDb();
});
afterAll(async () => {
  await db?.close();
});

describe("pg-boss 独立 worker 链路", () => {
  it("Web 侧入队的任务由 worker 处理，且 pg-boss 表在独立 schema", async () => {
    const received: HeartbeatPayload[] = [];
    const worker = await startWorker(db.url, (p) => received.push(p));

    const producer = createBoss(db.url);
    await producer.start();
    await producer.send(QUEUES.heartbeat, { requestedAt: "t1" });

    const deadline = Date.now() + 20_000;
    while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([{ requestedAt: "t1" }]);

    const { Client } = await import("pg");
    const c = new Client({ connectionString: db.url });
    await c.connect();
    const { rows } = await c.query("select count(*)::int n from information_schema.tables where table_schema='pgboss'");
    await c.end();
    expect(rows[0].n).toBeGreaterThan(0);

    await producer.stop({ graceful: true, timeout: 10_000 });
    await worker.stop();
  });
});
