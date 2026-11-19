import { describe, expect, it } from "vitest";
import type { Attribution, Person } from "@digestor/core";
import { clockTime, quoteSpeakers, quoteWithSource, sourceLink } from "./quoteSource";

const person = (id: string, displayName: string): Person => ({
  id, displayName, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "a", sessionId: "s", speakerId: "A", startMs: null, endMs: null, personId: "P", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...o,
});

describe("clockTime", () => {
  it("writes h:mm:ss", () => {
    expect(clockTime(0)).toBe("0:00:00");
    expect(clockTime(723_900)).toBe("0:12:03");
    expect(clockTime(3_723_000)).toBe("1:02:03");
  });
});

describe("sourceLink", () => {
  it("links a YouTube session at the moment's second", () => {
    const s = { source: "youtube" as const, sourceUrl: "https://youtu.be/dQw4w9WgXcQ?si=abc", sourceStartMs: null };
    expect(sourceLink(s, 723_900)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=723s");
  });
  it("adds the part's start for a clipped Câmara speech", () => {
    const s = { source: "youtube" as const, sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", sourceStartMs: 3_600_000 };
    expect(sourceLink(s, 10_000)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3610s");
  });
  it("has none for uploads or a URL that isn't a YouTube video", () => {
    expect(sourceLink({ source: "upload", sourceUrl: null, sourceStartMs: null }, 0)).toBeNull();
    expect(sourceLink({ source: "youtube", sourceUrl: "https://example.com/x", sourceStartMs: null }, 0)).toBeNull();
    expect(sourceLink({ source: "youtube", sourceUrl: null, sourceStartMs: null }, 0)).toBeNull();
  });
});

describe("quoteSpeakers", () => {
  const persons = [person("P", "Ana Silva"), person("Q", "Bia Lima")];
  const voices = [{ speakerId: "A", atMs: 0 }, { speakerId: "B", atMs: 5_000 }, { speakerId: "C", atMs: 6_000 }];

  it("names voices as the session does, marking a name nobody confirmed", () => {
    const names = { persons, attributions: [att({ speakerId: "A", personId: "P" }), att({ speakerId: "B", personId: "Q", source: "transcript", status: "proposed" })] };
    expect(quoteSpeakers(names, voices, false)).toEqual(["Ana Silva", "Bia Lima (name not confirmed)"]);
  });

  it("in a sensitive profile uses confirmed names only", () => {
    const names = { persons, attributions: [att({ speakerId: "A", personId: "P" }), att({ speakerId: "B", personId: "Q", source: "transcript", status: "proposed" })] };
    expect(quoteSpeakers(names, voices, true)).toEqual(["Ana Silva"]);
  });

  it("never names a voice marked No name, and lists a person once", () => {
    const names = {
      persons,
      attributions: [att({ speakerId: "A", personId: "P" }), att({ speakerId: "B", personId: "P" }), att({ id: "n", speakerId: "C", personId: null, status: "anonymous" })],
    };
    expect(quoteSpeakers(names, voices, false)).toEqual(["Ana Silva"]);
  });
});

describe("quoteWithSource", () => {
  it("is the quote, who said it, the video, the time range and the link", () => {
    expect(
      quoteWithSource({ quote: "We will build homes.", speakers: ["Ana Silva"], title: "Housing debate", startMs: 723_000, endMs: 790_000, link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=723s" }),
    ).toBe("“We will build homes.”\n— Ana Silva, Housing debate, 0:12:03–0:13:10\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ&t=723s");
  });

  it("leaves out the name and the link when there are none", () => {
    expect(quoteWithSource({ quote: "Homes.", speakers: [], title: "Housing debate", startMs: 0, endMs: 5_000, link: null })).toBe("“Homes.”\n— Housing debate, 0:00:00–0:00:05");
  });

  it("joins several speakers", () => {
    expect(quoteWithSource({ quote: "Yes. No.", speakers: ["Ana Silva", "Bia Lima"], title: "T", startMs: 0, endMs: 1_000, link: null })).toBe("“Yes. No.”\n— Ana Silva and Bia Lima, T, 0:00:00–0:00:01");
  });
});
