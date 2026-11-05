import { describe, expect, it } from "vitest";
import { exportRows, inFlight, toMake } from "./exportRows";

const clip = (over: Partial<Parameters<typeof exportRows>[0][number]> = {}) => ({
  id: "c1", sessionId: "s1", renderStatus: "done" as const, renderKey: "s1/clips/c1.mp4", ...over,
});
const track = (over: Partial<Parameters<typeof exportRows>[1][number]> = {}) => ({
  clipId: "c1", language: "pt", status: "ready" as const, cues: [{ startMs: 0, endMs: 1000, original: "Hello", text: "Olá", missing: false }],
  approvedAt: null as Date | null, burnStatus: "none" as const, burnKey: null, ...over,
});

describe("exportRows", () => {
  it("an outdated track has no subtitle links and says so (R27)", () => {
    const [row] = exportRows([clip()], [track({ status: "outdated" })]);
    expect(row!.languages[0]).toMatchObject({ srt: null, vtt: null, outdated: true });
    expect(exportRows([clip()], [track()])[0]!.languages[0]).toMatchObject({ outdated: false });
  });

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
      burn: { status: "done", url: "/api/files/s1/clips/c1.en.burned.mp4?download=1", state: "done" },
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
    expect(pt.burn).toMatchObject({ url: null, state: "outOfDate" });
    expect(pt.srt).not.toBeNull();
  });

  it("encodes odd language codes in the URL", () => {
    const rows = exportRows([clip()], [track({ language: "zh-Hans" })]);
    expect(rows[0]!.languages[0]!.srt).toBe("/api/files/s1/clips/c1.zh-Hans.srt?download=1");
  });
});

describe("burn state and toMake", () => {
  it("a requested burn that was never made is notMade, not out of date", () => {
    const [row] = exportRows([clip()], [track({ burnStatus: "stale", burnKey: null })]);
    expect(row!.languages[0]!.burn).toMatchObject({ state: "notMade", url: null });
  });
  it("maps the other statuses", () => {
    const st = (burnStatus: "none" | "queued" | "rendering" | "done" | "failed", burnKey: string | null = null) =>
      exportRows([clip()], [track({ burnStatus, burnKey })])[0]!.languages[0]!.burn.state;
    expect(st("none")).toBe("none");
    expect(st("queued")).toBe("making");
    expect(st("rendering")).toBe("making");
    expect(st("done", "k")).toBe("done");
    expect(st("failed")).toBe("failed");
  });
  it("toMake counts notMade, outOfDate and failed approved tracks", () => {
    const rows = exportRows(
      [clip(), clip({ id: "c2" })],
      [track({ burnStatus: "stale" }), track({ clipId: "c2", burnStatus: "stale", burnKey: "k" })],
    );
    expect(toMake(rows)).toBe(2);
    expect(toMake(exportRows([clip()], [track({ burnStatus: "failed", approvedAt: new Date() })]))).toBe(1);
    expect(toMake(exportRows([clip()], [track({ burnStatus: "failed" })]))).toBe(0);
  });
});

describe("inFlight", () => {
  it("is true while any clip render or track burn is queued or rendering", () => {
    expect(inFlight(exportRows([clip()], [track()]))).toBe(false);
    expect(inFlight(exportRows([clip({ renderStatus: "queued" })], []))).toBe(true);
    expect(inFlight(exportRows([clip()], [track({ burnStatus: "rendering" })]))).toBe(true);
    expect(inFlight(exportRows([clip({ renderStatus: "failed" })], [track({ burnStatus: "failed" })]))).toBe(false);
  });

  it("watch: plain inline URLs for the MP4, text tracks and done subtitle videos", () => {
    const rows = exportRows(
      [clip()],
      [
        track({ language: "de" }),
        track({ language: "pt", status: "outdated" }),
        track({ language: "fr", cues: [] }),
        track({ language: "en", burnStatus: "done", burnKey: "s1/clips/c1.en.burned.mp4" }),
        track({ language: "es", burnStatus: "stale", burnKey: "k" }),
      ],
    );
    expect(rows[0]!.watch).toEqual({
      mp4: "/api/files/s1/clips/c1.mp4",
      tracks: [
        { src: "/api/files/s1/clips/c1.de.vtt", srcLang: "de", label: "German" },
        { src: "/api/files/s1/clips/c1.en.vtt", srcLang: "en", label: "English" },
        { src: "/api/files/s1/clips/c1.es.vtt", srcLang: "es", label: "Spanish" },
      ],
      burned: [{ language: "en", src: "/api/files/s1/clips/c1.en.burned.mp4" }],
    });
    expect(exportRows([clip({ renderStatus: "stale" })], [track()])[0]!.watch.mp4).toBeNull();
  });
});
