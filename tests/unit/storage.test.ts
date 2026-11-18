import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { createLocalStorage } from "@/server/storage/local";
import { describeStorageContract } from "../support/storage-contract";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rel-storage-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeStorageContract("私有存储契约 · 本地模拟实现", (o) => createLocalStorage({ dir, ...o }));
