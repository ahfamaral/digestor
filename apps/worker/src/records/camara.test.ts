import { describe, expect, it, vi } from "vitest";
import { mapLimit } from "./http.js";
import { RecordNotFoundError } from "./types.js";
import { CAMARA_CANCELLED, CAMARA_NOT_COMPLETE, camaraConnector, fetchCamaraDay, fetchCamaraSpeeches } from "./camara.js";
import { senadoConnector } from "./senado.js";
import { fixtureDeputados } from "./fakeCamara.js";
import { fixtureEventoComissao } from "./fakeCamara.js";
import { fixtureEventosDia } from "./fakeCamara.js";
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
    moved.dados[0]!.dataHoraInicio = "2026-06-30T13:48"; // the block before the one holding the start (13:52)
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

describe("fetchCamaraSpeeches: block stamps, plenary and completeness", () => {
  const only = (over: object) => (id: string) => json(id === "152605" ? over : fixtureDiscursos[id] ?? { dados: [] });

  it("keeps a speech stamped in the 4-minute block that contains the event's start", async () => {
    const early = structuredClone(fixtureDiscursos["152605"]!);
    early.dados[0]!.dataHoraInicio = "2026-06-30T13:52"; // the event starts 13:55, inside the 13:52 block
    early.dados[1]!.dataHoraInicio = "2026-06-30T13:48"; // the block before: out
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch({ discursos: only(early) }).f);
    const mine = speeches.filter((x) => x.officialId === "152605");
    expect(mine.map((x) => x.id)).toContain("152605-2026-06-30T13:52-0");
    expect(mine).toHaveLength(3);
  });

  it("carries the speech's stamp as `at`", async () => {
    const { speeches } = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch().f);
    expect(speeches[0]!.at).toBe("2026-06-30T15:48");
  });

  it("refuses an event that isn't a plenary session, without sweeping the deputies", async () => {
    const { f, calls } = fakeCamaraFetch({ evento: () => json(fixtureEventoComissao) });
    await expect(fetchCamaraSpeeches("82332", f)).rejects.toThrow(new RecordNotFoundError("Only Câmara plenary sessions are supported."));
    expect(calls.filter((c) => c.includes("/deputados"))).toEqual([]);
  });

  it("refuses an event that hasn't ended, without sweeping the deputies", async () => {
    const open = structuredClone(fixtureEvento);
    open.dados.situacao = "Em Andamento";
    const { f, calls } = fakeCamaraFetch({ evento: () => json(open) });
    await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, f)).rejects.toThrow(new RecordNotFoundError("The Câmara record of this session isn't complete yet. Try again later."));
    expect(calls.filter((c) => c.includes("/deputados"))).toEqual([]);
  });
});

describe("get", () => {
  it("retries a 429 once like a 5xx", async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response("slow down", { status: 429 }) : json({ ok: 1 }))) as typeof fetch;
    const { getJson } = await import("./http.js");
    await expect(getJson("https://x", f, "Câmara")).resolves.toEqual({ status: 200, body: { ok: 1 } });
    expect(n).toBe(2);
    n = -5;
    await expect(getJson("https://x", (async () => { n++; return new Response("", { status: 429 }); }) as typeof fetch, "Câmara")).rejects.toThrow("429");
    expect(n).toBe(-3);
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

describe("fetchCamaraSpeeches: cancelled sessions", () => {
  const withSituacao = (situacao: string) => {
    const ev = structuredClone(fixtureEvento);
    ev.dados.situacao = situacao;
    return fakeCamaraFetch({ evento: () => json(ev) }).f;
  };
  const CANCELLED = "This Câmara session was cancelled or never confirmed.";

  it("says cancelled for Cancelada… and Não Confirmada", async () => {
    for (const s of ["Cancelada", "Cancelada pela Presidência", "Não Confirmada"]) {
      await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, withSituacao(s))).rejects.toThrow(new RecordNotFoundError(CANCELLED));
    }
  });

  it("keeps the 'isn't complete yet' line for other states", async () => {
    for (const s of ["Em Andamento", "Convocada", "Não Confirmada pela Mesa"]) {
      await expect(fetchCamaraSpeeches(FIXTURE_EVENT_ID, withSituacao(s))).rejects.toThrow(
        new RecordNotFoundError("The Câmara record of this session isn't complete yet. Try again later."),
      );
    }
  });
});

describe("fetchCamaraDay", () => {
  const DAY = "2026-06-30";
  const listOf = (ids: number[], patch: (e: { id: number; situacao: string; [k: string]: unknown }) => void = () => {}) => {
    const dados = structuredClone(fixtureEventosDia.dados).filter((e) => ids.includes(e.id));
    dados.forEach(patch);
    return () => json({ dados, links: [] });
  };
  /** The solemn session 81818 (12:23-13:26) with two of the fixture's deputies, one of whom (152605) also spoke in it at 12:40. */
  const solemn = () => {
    const entry = fixtureEventosDia.dados.find((e) => e.id === 81818)!;
    const deputados = { dados: fixtureDeputados.dados.filter((d: { id: number }) => [152605, 62881].includes(d.id)), links: [] };
    const discursos152605 = structuredClone(fixtureDiscursos["152605"]!);
    discursos152605.dados.push({ ...discursos152605.dados[0]!, dataHoraInicio: "2026-06-30T12:40", transcricao: "O SR. GLAUBER BRAGA (PSOL - RJ. Sem revisão do orador.) - Homenagem solene." });
    return { extraEvents: { "81818": { evento: { dados: entry, links: [] }, deputados } }, discursos: (id: string) => json(id === "152605" ? discursos152605 : fixtureDiscursos[id] ?? { dados: [], links: [] }) };
  };

  it("asks the Plenário's events of the day, and a day with one ended plenary gives the event-id path's speeches", async () => {
    const byId = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch().f);
    const { f, calls } = fakeCamaraFetch({ eventos: listOf([82635]) });
    const day = await fetchCamaraDay(DAY, f);
    expect(day.speeches).toEqual(byId.speeches);
    expect(day.date).toBe(DAY);
    expect(day.deputies).toEqual(byId.deputies);
    expect(calls[0]).toBe("https://dadosabertos.camara.leg.br/api/v2/eventos?dataInicio=2026-06-30&dataFim=2026-06-30&itens=100&idOrgao=180");
  });

  it("two ended plenaries give both events' speeches in stamp order, with the deputies merged", async () => {
    const o = solemn();
    const { f } = fakeCamaraFetch({ eventos: listOf([82635, 81818]), ...o });
    const day = await fetchCamaraDay(DAY, f);
    const byId = await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch().f);
    expect(day.speeches).toHaveLength(byId.speeches.length + 1);
    expect(day.speeches[0]).toMatchObject({ id: "152605-2026-06-30T12:40-0", at: "2026-06-30T12:40", order: 1, officialId: "152605" });
    expect(day.speeches.slice(1).map((s) => s.id)).toEqual(byId.speeches.map((s) => s.id));
    expect(day.speeches.map((s) => s.order)).toEqual(day.speeches.map((_, i) => i + 1));
    expect(Object.keys(day.deputies).sort()).toEqual([...SPEAKER_IDS, ...SILENT_IDS].sort());
  });

  it("skips a cancelled plenary, a committee in the list and a plenary with no speeches", async () => {
    const o = solemn();
    const cancelled = fakeCamaraFetch({ eventos: listOf([82635, 81818], (e) => { if (e.id === 81818) e.situacao = "Cancelada"; }), ...o });
    const day = await fetchCamaraDay(DAY, cancelled.f);
    expect(day.speeches).toHaveLength((await fetchCamaraSpeeches(FIXTURE_EVENT_ID, fakeCamaraFetch().f)).speeches.length);
    expect(cancelled.calls.some((c) => c.includes("/eventos/81818"))).toBe(false);
    // a non-PLEN event the server let through is filtered in code
    const withCommittee = fakeCamaraFetch({ eventos: () => json({ dados: [...fixtureEventosDia.dados.filter((e) => e.id === 82635), { ...fixtureEventoComissao.dados, id: 82332 }], links: [] }) });
    await fetchCamaraDay(DAY, withCommittee.f);
    expect(withCommittee.calls.some((c) => c.includes("/eventos/82332"))).toBe(false);
    // 81818 ended but nobody spoke in its window: the day still reads from 82635
    const quiet = fakeCamaraFetch({ eventos: listOf([82635, 81818]), extraEvents: o.extraEvents });
    expect((await fetchCamaraDay(DAY, quiet.f)).speeches.length).toBeGreaterThan(0);
    // every plenary cancelled
    await expect(fetchCamaraDay(DAY, fakeCamaraFetch({ eventos: listOf([82635], (e) => { e.situacao = "Não Confirmada"; }) }).f)).rejects.toThrow(new RecordNotFoundError(CAMARA_CANCELLED));
  });

  it("a day whose only plenary isn't Encerrada says the record isn't complete, without sweeping the deputies", async () => {
    const { f, calls } = fakeCamaraFetch({ eventos: listOf([82635], (e) => { e.situacao = "Convocada"; }) });
    await expect(fetchCamaraDay(DAY, f)).rejects.toThrow(new RecordNotFoundError(CAMARA_NOT_COMPLETE));
    expect(calls.filter((c) => c.includes("/deputados"))).toEqual([]);
    // one ended plenary does not make a day complete while another one is still open
    const mixed = fakeCamaraFetch({ eventos: listOf([82635, 81818], (e) => { if (e.id === 81818) e.situacao = "Em Andamento"; }), ...solemn() });
    await expect(fetchCamaraDay(DAY, mixed.f)).rejects.toThrow(new RecordNotFoundError(CAMARA_NOT_COMPLETE));
  });

  it("a day with no plenary says so", async () => {
    await expect(fetchCamaraDay("2026-06-28", fakeCamaraFetch({ eventos: () => json({ dados: [], links: [] }) }).f)).rejects.toThrow(
      new RecordNotFoundError("The Câmara has no plenary session on that date."),
    );
  });

  it("reads every page of the day's list", async () => {
    let n = 0;
    const [a, b] = [fixtureEventosDia.dados.filter((e) => e.id === 81818), fixtureEventosDia.dados.filter((e) => e.id === 82635)];
    const f = fakeCamaraFetch({ eventos: () => (++n === 1 ? json({ dados: a, links: [{ rel: "next", href: "https://dadosabertos.camara.leg.br/api/v2/eventos?pagina=2" }] }) : json({ dados: b, links: [] })), ...solemn() });
    const day = await fetchCamaraDay(DAY, f.f);
    expect(day.speeches[0]!.id).toBe("152605-2026-06-30T12:40-0");
    expect(f.calls).toContain("https://dadosabertos.camara.leg.br/api/v2/eventos?pagina=2");
  });
});

describe("camaraConnector", () => {
  it("fetchRecord dispatches a day ref to the day and an event ref to the event", async () => {
    const day = await camaraConnector.fetchRecord({ chamber: "camara", date: "2026-06-30", url: "u" }, fakeCamaraFetch({ eventos: () => json({ dados: fixtureEventosDia.dados.filter((e) => e.id === 82635), links: [] }) }).f, { now: new Date(), linkedAt: new Date() });
    const ev = await camaraConnector.fetchRecord({ chamber: "camara", eventId: FIXTURE_EVENT_ID, url: "u" }, fakeCamaraFetch().f, { now: new Date(), linkedAt: new Date() });
    expect(day.date).toBe("2026-06-30");
    expect(day.speeches).toEqual(ev.speeches);
    expect(day.members["152605"]).toMatchObject({ displayName: "Glauber Braga" });
  });

  it("a ref of another house is a deterministic RecordNotFoundError, in both Brazilian connectors", async () => {
    const ctx = { now: new Date(), linkedAt: new Date() };
    const f = (async () => { throw new Error("no network expected"); }) as typeof fetch;
    const senadoRef = { chamber: "senado", date: "2026-06-30", sessionCode: null, url: "u" } as const;
    const camaraRef = { chamber: "camara", eventId: "1", url: "u" } as const;
    await expect(camaraConnector.fetchRecord(senadoRef, f, ctx)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(senadoConnector.fetchRecord(camaraRef, f, ctx)).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});
