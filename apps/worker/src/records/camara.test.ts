import { describe, expect, it, vi } from "vitest";
import { mapLimit } from "./http.js";
import { RecordNotFoundError } from "./senado.js";
import { fetchCamaraSpeeches } from "./camara.js";
import { fixtureDeputados } from "./fakeCamara.js";
import { FIXTURE_DATE, FIXTURE_EVENT_ID, SILENT_IDS, SPEAKER_IDS, fakeCamaraFetch, fixtureDiscursos, fixtureEvento } from "./fakeCamara.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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
    expect(speeches.at(-1)).toMatchObject({ officialId: "152605", id: "152605-2026-06-30T23:30-0" });
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

  it("ids don't shift when a speech is added later the same day, and number speeches of one minute", async () => {
    const base = structuredClone(fixtureDiscursos["152605"]!) as { dados: Record<string, unknown>[] };
    const twin = { ...base.dados[0]!, transcricao: "Um segundo discurso no mesmo minuto, mais curto." };
    const first = { ...base, dados: [base.dados[0]!, twin, ...base.dados.slice(1)] };
    const extra = { ...base.dados[1]!, dataHoraInicio: "2026-06-30T16:13", transcricao: "Um discurso novo." };
    const second = { ...first, dados: [extra, ...first.dados] }; // newest-first API: a new one appears at the top
    const run = async (a: unknown) =>
      (await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch({ discursos: (id) => json(id === "152605" ? a : fixtureDiscursos[id] ?? { dados: [] }) }).f)).speeches.filter((x) => x.officialId === "152605");
    const before = await run(first);
    const after = await run(second);
    const minute = before.filter((x) => x.id.includes("T16:44"));
    expect(minute.map((x) => x.id)).toEqual(["152605-2026-06-30T16:44-0", "152605-2026-06-30T16:44-1"]);
    expect(minute[0]!.text).toBe("Um segundo discurso no mesmo minuto, mais curto."); // shorter text sorts first
    for (const b of before) expect(after.find((x) => x.id === b.id)?.text).toBe(b.text);
    expect(after).toHaveLength(before.length + 1);
  });

  it("logs and skips a deputy whose speeches page is a 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fakeCamaraFetch({ discursos: (id) => (id === "204528" ? new Response("{}", { status: 404 }) : json(fixtureDiscursos[id] ?? { dados: [] })) });
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, f);
    expect(speeches.some((x) => x.officialId === "204528")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deputy 204528"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`event ${FIXTURE_EVENT_ID}`));
    warn.mockRestore();
  });

  it("follows the next link of a deputy's speeches and of the event's deputies", async () => {
    const one = fixtureDiscursos["152605"]!;
    const page1 = { dados: one.dados.slice(0, 2), links: [{ rel: "self", href: "x" }, { rel: "next", href: "https://dadosabertos.camara.leg.br/api/v2/deputados/152605/discursos?pagina=2" }] };
    const page2 = { dados: one.dados.slice(2), links: [{ rel: "self", href: "y" }] };
    const depPage1 = { dados: [fixtureDeputadosAll()[0]], links: [{ rel: "next", href: "https://dadosabertos.camara.leg.br/api/v2/eventos/82635/deputados?pagina=2" }] };
    const depPage2 = { dados: fixtureDeputadosAll().slice(1), links: [] };
    const { f, calls } = fakeCamaraFetch({
      deputados: () => json(depPage1),
      discursos: (id) => json(id === "152605" ? page1 : fixtureDiscursos[id] ?? { dados: [] }),
    });
    const paged = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/deputados?pagina=2")) return json(depPage2);
      if (url.endsWith("/discursos?pagina=2")) { calls.push(url); return json(page2); }
      return f(input);
    }) as typeof fetch;
    const { speeches, deputies } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, paged);
    expect(Object.keys(deputies)).toHaveLength(8);
    expect(speeches.filter((x) => x.officialId === "152605")).toHaveLength(one.dados.length);
    expect(calls).toContain("https://dadosabertos.camara.leg.br/api/v2/deputados/152605/discursos?pagina=2");
  });
});

describe("mapLimit", () => {
  it("starts no new item once one has failed, then rejects", async () => {
    const started: number[] = [];
    const p = mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 5));
      if (i === 1) throw new Error("boom");
      return i;
    });
    await expect(p).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 40));
    expect(started.length).toBeLessThanOrEqual(4); // the two in flight, plus at most the one each worker took before the failure landed
    expect(started).not.toContain(7);
  });
});

const fixtureDeputadosAll = () => fixtureDeputados.dados as { id: number }[];
