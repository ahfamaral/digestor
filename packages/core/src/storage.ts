import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export class UnsafePathError extends Error {
  constructor(value: string) {
    super(`Unsafe path: ${value}`);
    this.name = "UnsafePathError";
  }
}

export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upload exceeds the limit of ${maxBytes} bytes`);
    this.name = "UploadTooLargeError";
  }
}

function assertSafe(value: string, allowSlash: boolean): void {
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    (!allowSlash && value.includes("/")) ||
    value.split("/").some((p) => p === ".." || p === "." || p === "")
  ) {
    throw new UnsafePathError(value);
  }
}

export class LocalStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  key(sessionId: string, file: string): string {
    assertSafe(sessionId, false);
    assertSafe(file, true);
    if (file.split("/").length > 2) throw new UnsafePathError(file);
    return `${sessionId}/${file}`;
  }

  resolve(key: string): string {
    assertSafe(key, true);
    const full = path.join(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new UnsafePathError(key);
    mkdirSync(path.dirname(full), { recursive: true });
    return full;
  }

  async saveStream(
    sessionId: string,
    file: string,
    body: ReadableStream<Uint8Array>,
    maxBytes?: number,
  ): Promise<string> {
    const key = this.key(sessionId, file);
    const target = this.resolve(key);
    let seen = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (maxBytes !== undefined && seen > maxBytes) cb(new UploadTooLargeError(maxBytes));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), limiter, createWriteStream(target));
    } catch (err) {
      await rm(target, { force: true });
      throw err;
    }
    return key;
  }

  async removeSession(sessionId: string): Promise<void> {
    assertSafe(sessionId, false);
    await rm(path.join(this.root, sessionId), { recursive: true, force: true });
  }

  /** Deletes the session's `audio.mp3` (only transcription reads it; a `ready` session no longer needs it). A missing file is fine. */
  async removeAudio(sessionId: string): Promise<void> {
    assertSafe(sessionId, false);
    await rm(path.join(this.root, sessionId, "audio.mp3"), { force: true });
  }

  /** Deletes the session's source media (`original.*`, `audio.mp3`, `proxy.mp4`); thumbnails and `clips/` stay. */
  async removeVideoFiles(sessionId: string): Promise<void> {
    assertSafe(sessionId, false);
    const dir = path.join(this.root, sessionId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      if (/^original\.[^/]+$/.test(name) || name === "audio.mp3" || name === "proxy.mp4") await rm(path.join(dir, name), { force: true });
    }
  }
}
