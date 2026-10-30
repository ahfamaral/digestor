import { describe, expect, it } from "vitest";
import { exportRows, inFlight } from "./exportRows";

const clip = (over: Partial<Parameters<typeof exportRows>[0][number]> = {}) => ({
  id: "c1", sessionId: "s1", renderStatus: "done" as const, renderKey: "s1/clips/c1.mp4", ...over,
});
const track = (over: Partial<Parameters<typeof exportRows>[1][number]> = {}) => ({
  clipId: "c1", language: "pt", status: "ready" as const, cues: [{ startMs: 0, endMs: 1000, original: "Hello", text: "Olá", missing: false }],
  burnStatus: "none" as const, burnKey: null, ...over,
});

describe("exportRows", () => {
  it("groups files per clip and language", () => {
    const rows = exportRows(
      [clip(), clip({ id: "c2", renderStatus: "none", renderKey: null })],
      [
        track(),
        track({ language: "en", burnStatus: "done", burnKey: "s1/clips/c1.en.burned.mp4" }),
        track({ clipId: "c2", language: "es" }),
      ],
    );
    expect(rows.map((r) => r.clipId)).toEqual(["c1", "c2"]);
    expect(rows[0]!.mp4).toBe("/api/files/s1/clips/c1.mp4?download=1");
    expect(rows[0]!.languages.map((l) => l.language)).toEqual(["en", "pt"]);
    expect(rows[0]!.languages[0]).toMatchObject({
      srt: "/api/files/s1/clips/c1.en.srt?download=1",
      vtt: "/api/files/s1/clips/c1.en.vtt?download=1",
      burn: { status: "done", url: "/api/files/s1/clips/c1.en.burned.mp4?download=1", outOfDate: false },
    });
    expect(rows[0]!.languages[1]!.burn).toMatchObject({ status: "none", url: null });
    expect(rows[1]!.mp4).toBeNull();
    expect(rows[1]!.languages.map((l) => l.language)).toEqual(["es"]);
  });

  it("offers no link for an out-of-date render or burn, and none for an empty track", () => {
    const rows = exportRows(
      [clip({ renderStatus: "stale" })],
      [track({ burnStatus: "stale", burnKey: "k" }), track({ language: "fr", cues: [] })],
    );
    expect(rows[0]!.mp4).toBeNull();
    expect(rows[0]!.renderOutOfDate).toBe(true);
    const fr = rows[0]!.languages.find((l) => l.language === "fr")!;
    expect(fr.srt).toBeNull();
    const pt = rows[0]!.languages.find((l) => l.language === "pt")!;
    expect(pt.burn).toMatchObject({ url: null, outOfDate: true });
    expect(pt.srt).not.toBeNull();
  });

  it("encodes odd language codes in the URL", () => {
    const rows = exportRows([clip()], [track({ language: "zh-Hans" })]);
    expect(rows[0]!.languages[0]!.srt).toBe("/api/files/s1/clips/c1.zh-Hans.srt?download=1");
  });
});

describe("inFlight", () => {
  it("is true while any clip render or track burn is queued or rendering", () => {
    expect(inFlight(exportRows([clip()], [track()]))).toBe(false);
    expect(inFlight(exportRows([clip({ renderStatus: "queued" })], []))).toBe(true);
    expect(inFlight(exportRows([clip()], [track({ burnStatus: "rendering" })]))).toBe(true);
    expect(inFlight(exportRows([clip({ renderStatus: "failed" })], [track({ burnStatus: "failed" })]))).toBe(false);
  });
});
