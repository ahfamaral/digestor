import { describe, expect, it } from "vitest";
import { RecordNotFoundError } from "./senado.js";
import { fetchCamaraSpeeches } from "./camara.js";
import { FIXTURE_DATE, FIXTURE_EVENT_ID, SILENT_IDS, SPEAKER_IDS, fakeCamaraFetch, fixtureDiscursos, fixtureEvento } from "./fakeCamara.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const times = (xs: { dataHoraInicio: string }[]) => xs.map((x) => x.dataHoraInicio);

describe("fetchCamaraSpeeches", () => {
  it("builds the session's speeches from the event's deputies, inside the event window, in time order", async () => {
    const { f, calls } = fakeCamaraFetch();
    const { speeches, date, deputies } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, f);
    expect(date).toBe(FIXTURE_DATE);
    const all = Object.values(fixtureDiscursos).flatMap((a) => a.dados);
    expect(speeches).toHaveLength(all.length);
    expect(speeches.map((s) => s.order)).toEqual(speeches.map((_, i) => i + 1));
    // ascending by minute (then by deputy id); Glauber's 15:48 is first, Cabo Gilberto's 19:56 last
    expect(speeches[0]).toMatchObject({ officialId: "152605", name: "Glauber Braga", textSource: "full" });
    expect(speeches.at(-1)).toMatchObject({ officialId: "220574" });
    expect(speeches[0]!.text).toMatch(/^O SR\. GLAUBER BRAGA/);
    expect(speeches[0]!.party).toBeTruthy();
    expect(speeches[0]!.state).toBeTruthy();
    expect(new Set(speeches.map((s) => s.id)).size).toBe(speeches.length);
    expect(Object.keys(deputies).sort()).toEqual([...SPEAKER_IDS, ...SILENT_IDS].sort());
    expect(deputies["204528"]).toMatchObject({ name: "Adriana Ventura", party: expect.any(String), state: expect.any(String), photoUrl: expect.stringMatching(/^https:\/\//) });
    // one call per event deputy, with the event's day as the range
    const dep = calls.filter((c) => c.includes("/deputados/"));
    expect(dep).toHaveLength(8);
    expect(dep[0]).toContain("dataInicio=2026-06-30&dataFim=2026-06-30&itens=100");
    expect(calls.some((c) => /\/eventos\/\d+\/discursos/.test(c))).toBe(false);
  });

  it("drops speeches outside the event's window", async () => {
    const moved = structuredClone(fixtureDiscursos["152605"]!);
    moved.dados[0]!.dataHoraInicio = "2026-06-30T13:54"; // a minute before the session starts
    moved.dados[1]!.dataHoraInicio = "2026-06-30T20:12"; // a minute after it ends (20:11)
    const { f } = fakeCamaraFetch({ discursos: (id) => (id === "152605" ? json(moved) : json(fixtureDiscursos[id] ?? { dados: [] })) });
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, f);
    expect(speeches.filter((s) => s.officialId === "152605")).toHaveLength(2);
    // the window's edges are inclusive
    const edge = structuredClone(moved);
    edge.dados[0]!.dataHoraInicio = "2026-06-30T13:55";
    edge.dados[1]!.dataHoraInicio = "2026-06-30T20:11";
    const again = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch({ discursos: (id) => json(id === "152605" ? edge : fixtureDiscursos[id] ?? { dados: [] }) }).f);
    expect(again.speeches.filter((s) => s.officialId === "152605")).toHaveLength(4);
  });

  it("an event with no end runs to the end of its day", async () => {
    const open = structuredClone(fixtureEvento);
    open.dados.dataHoraFim = null;
    const late = structuredClone(fixtureDiscursos["152605"]!);
    late.dados[0]!.dataHoraInicio = "2026-06-30T23:30";
    const { f } = fakeCamaraFetch({ evento: () => json(open), discursos: (id) => json(id === "152605" ? late : fixtureDiscursos[id] ?? { dados: [] }) });
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, f);
    expect(speeches.at(-1)).toMatchObject({ officialId: "152605" });
    expect(times(late.dados)).toContain("2026-06-30T23:30");
  });

  it("uses the summary when a speech has no transcription, and drops one with neither", async () => {
    const odd = structuredClone(fixtureDiscursos["152605"]!) as { dados: Record<string, unknown>[] };
    odd.dados[0] = { ...odd.dados[0]!, transcricao: "", sumario: "O deputado criticou o governo." };
    odd.dados[1] = { ...odd.dados[1]!, transcricao: null, sumario: null };
    const { f } = fakeCamaraFetch({ discursos: (id) => json(id === "152605" ? odd : fixtureDiscursos[id] ?? { dados: [] }) });
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, f);
    const mine = speeches.filter((s) => s.officialId === "152605");
    expect(mine).toHaveLength(3);
    expect(mine.find((s) => s.textSource === "summary")).toMatchObject({ text: "O deputado criticou o governo." });
  });

  it("throws RecordNotFoundError for an unknown event (404) and for a window with no speeches", async () => {
    await expect(fetchCamaraSpeeches("1", fakeCamaraFetch().f)).rejects.toThrow(new RecordNotFoundError("The Câmara has no speeches for that session."));
    const empty = fakeCamaraFetch({ discursos: () => json({ dados: [], links: [] }) });
    await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, empty.f)).rejects.toBeInstanceOf(RecordNotFoundError);
    const none = fakeCamaraFetch({ deputados: () => json({ dados: [], links: [] }) });
    await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, none.f)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("rethrows a deputy call that keeps failing", async () => {
    const down = fakeCamaraFetch({ discursos: (id) => (id === "204528" ? new Response("boom", { status: 503 }) : json(fixtureDiscursos[id] ?? { dados: [] })) });
    await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, down.f)).rejects.not.toBeInstanceOf(RecordNotFoundError);
    expect(down.calls.filter((c) => c.includes("/deputados/204528/"))).toHaveLength(2); // one retry
  });

  it("fails on an unexpected shape", async () => {
    await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch({ deputados: () => json({ nope: 1 }) }).f)).rejects.toThrow("unexpected shape");
  });
});
