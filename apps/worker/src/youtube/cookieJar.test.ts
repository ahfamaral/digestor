import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { liveJar, withYouTubeCookies } from "./cookieJar.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "jar-"));

describe("YouTube cookie jar", () => {
  it("seeds the live jar once, keeps what yt-dlp wrote back, and starts again from a new export", async () => {
    const dir = tmp();
    const source = path.join(dir, "secrets.txt");
    const env = { YTDLP_COOKIES_FILE: source, DATA_DIR: path.join(dir, "data") };
    writeFileSync(source, "export 1\n");
    const jar = (await liveJar(env))!;
    expect(jar).toBe(path.join(dir, "data", ".youtube", "cookies.txt"));
    expect(readFileSync(jar, "utf8")).toBe("export 1\n");
    expect(statSync(jar).mode & 0o777).toBe(0o600);

    writeFileSync(jar, "refreshed by yt-dlp\n"); // what a run writes back
    expect(await liveJar(env)).toBe(jar);
    expect(readFileSync(jar, "utf8")).toBe("refreshed by yt-dlp\n"); // kept

    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    writeFileSync(source, "export 2\n"); // the owner installs a fresh export
    await liveJar(env);
    expect(readFileSync(jar, "utf8")).toBe("export 2\n");
    expect(readFileSync(source, "utf8")).toBe("export 2\n"); // the mounted file is never written
    info.mockRestore();
  });

  it("no cookies configured, or the file missing: no jar", async () => {
    expect(await liveJar({})).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await liveJar({ YTDLP_COOKIES_FILE: "/nope/cookies.txt", DATA_DIR: tmp() })).toBeUndefined();
    warn.mockRestore();
  });

  it("runs one yt-dlp call at a time, and a failed call doesn't block the next", async () => {
    const order: string[] = [];
    const slow = withYouTubeCookies({}, async () => {
      order.push("a start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a end");
      throw new Error("boom");
    });
    const next = withYouTubeCookies({}, async () => {
      order.push("b");
      return 2;
    });
    await expect(slow).rejects.toThrow("boom");
    expect(await next).toBe(2);
    expect(order).toEqual(["a start", "a end", "b"]);
  });
});
