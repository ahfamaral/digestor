import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { LocalStorage, UnsafePathError, UploadTooLargeError } from "./storage.ts";

function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

describe("LocalStorage", () => {
  let root: string;
  let storage: LocalStorage;
  const id = "11111111-1111-1111-1111-111111111111";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "digestor-storage-"));
    storage = new LocalStorage(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("storage rejects traversal", () => {
    expect(() => storage.key(id, "../x")).toThrow(UnsafePathError);
    expect(() => storage.key(id, "/etc/passwd")).toThrow(UnsafePathError);
    expect(() => storage.key(id, "a\\b")).toThrow(UnsafePathError);
    expect(() => storage.key(id, "a/b/c")).toThrow(UnsafePathError);
    expect(() => storage.key(id, "clips/../x")).toThrow(UnsafePathError);
    expect(() => storage.key("a/b", "x")).toThrow(UnsafePathError);
    expect(() => storage.key("../evil", "x")).toThrow(UnsafePathError);
    expect(() => storage.resolve("../x")).toThrow(UnsafePathError);
    expect(() => storage.resolve(`${id}/../../x`)).toThrow(UnsafePathError);
  });

  it("allows one level of subfolder and creates parents on resolve", () => {
    const key = storage.key(id, "clips/x.mp4");
    expect(key).toBe(`${id}/clips/x.mp4`);
    expect(storage.resolve(key)).toBe(path.join(path.resolve(root), id, "clips", "x.mp4"));
    expect(existsSync(path.join(root, id, "clips"))).toBe(true);
  });

  it("storage returns relative keys", async () => {
    const key = await storage.saveStream(id, "original.mp4", bodyOf(new Uint8Array([1, 2, 3])));
    expect(key).toBe(`${id}/original.mp4`);
    expect([...readFileSync(storage.resolve(key))]).toEqual([1, 2, 3]);
  });

  it("storage aborts oversized uploads", async () => {
    const body = bodyOf(new Uint8Array(8), new Uint8Array(12));
    await expect(storage.saveStream(id, "original.mp4", body, 10)).rejects.toThrow(UploadTooLargeError);
    expect(existsSync(path.join(root, id, "original.mp4"))).toBe(false);
  });

  it("removeSession deletes the session folder", async () => {
    await storage.saveStream(id, "original.mp4", bodyOf(new Uint8Array(1)));
    await storage.removeSession(id);
    expect(existsSync(path.join(root, id))).toBe(false);
  });
});
