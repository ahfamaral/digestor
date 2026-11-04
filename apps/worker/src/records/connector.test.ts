import { describe, expect, it } from "vitest";
import { RecordNotFoundError, RecordNotPublishedError, notPublishedOrNotFound, waitingLine } from "./connector.js";
import { senadoConnector } from "./senado.js";
import { camaraConnector } from "./camara.js";
import { FIXTURE_EVENT_ID, fakeCamaraFetch, fixtureEvento } from "./fakeCamara.js";

const NOW = new Date("2026-11-04T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const LINKED = new Date("2026-11-04T10:00:00Z");

describe("notPublishedOrNotFound", () => {
  it("senado: day 2 waits, day 3 is not found", () => {
    expect(notPublishedOrNotFound("senado", daysAgo(1), NOW, "nf")).toBeInstanceOf(RecordNotPublishedError);
    expect(notPublishedOrNotFound("senado", daysAgo(2), NOW, "nf")).toBeInstanceOf(RecordNotPublishedError);
    expect(notPublishedOrNotFound("senado", daysAgo(3), NOW, "nf")).toEqual(new RecordNotFoundError("nf"));
  });
  it("bundestag: 21 days wait, 22 are not found", () => {
    expect(notPublishedOrNotFound("bundestag", daysAgo(20), NOW, "nf")).toBeInstanceOf(RecordNotPublishedError);
    expect(notPublishedOrNotFound("bundestag", daysAgo(21), NOW, "nf")).toBeInstanceOf(RecordNotPublishedError);
    expect(notPublishedOrNotFound("bundestag", daysAgo(22), NOW, "nf")).toBeInstanceOf(RecordNotFoundError);
  });
  it("without a date the window counts from the link", () => {
    expect(notPublishedOrNotFound("bundestag", null, NOW, "nf", LINKED)).toBeInstanceOf(RecordNotPublishedError);
    expect(notPublishedOrNotFound("bundestag", null, NOW, "nf", new Date("2026-10-13T00:00:00Z"))).toBeInstanceOf(RecordNotFoundError); // 22 days
  });
});

describe("waitingLine", () => {
  it("names the house and the day, or the sitting", () => {
    expect(waitingLine({ chamber: "senado", date: "2026-11-03", sessionCode: null, url: "x" })).toBe(
      "The Senado hasn't published the record of 03/11/2026 yet. Digestor will check again. If there was no sitting that day, check the date.",
    );
  });
});

const empty = (async () => new Response(JSON.stringify({ dados: [], links: [] }), { status: 200 })) as typeof fetch;
const ctx = { now: NOW, linkedAt: LINKED };

describe("connectors convert an empty day by age", () => {
  it("senado", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const ref = (date: string) => ({ chamber: "senado" as const, date, sessionCode: null, url: "x" });
    await expect(senadoConnector.fetchRecord(ref(daysAgo(1)), notFound, ctx)).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(senadoConnector.fetchRecord(ref(daysAgo(3)), notFound, ctx)).rejects.toThrow(new RecordNotFoundError("The Senado has no speeches for that date."));
  });
  it("camara day: no plenary waits when recent, keeps its line when old", async () => {
    const ref = (date: string) => ({ chamber: "camara" as const, date, url: "x" });
    await expect(camaraConnector.fetchRecord(ref(daysAgo(1)), empty, ctx)).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(camaraConnector.fetchRecord(ref(daysAgo(3)), empty, ctx)).rejects.toThrow(new RecordNotFoundError("The Câmara has no plenary session on that date."));
  });
  it("camara event that is not Encerrada: waits while the event is recent, says so at once when the event is old; cancelled never waits", async () => {
    const ref = { chamber: "camara" as const, eventId: FIXTURE_EVENT_ID, url: "x" };
    const withSituacao = (situacao: string) => {
      const ev = structuredClone(fixtureEvento);
      ev.dados.situacao = situacao;
      return fakeCamaraFetch({ evento: () => new Response(JSON.stringify(ev), { status: 200 }) }).f;
    };
    // the window counts from the event's own date (2026-06-30 in the fixture), not from the link
    const evOld = { now: new Date("2026-07-05T10:00:00Z"), linkedAt: new Date("2026-07-05T09:00:00Z") };
    const evRecent = { now: new Date("2026-07-01T10:00:00Z"), linkedAt: new Date("2026-06-20T09:00:00Z") };
    await expect(camaraConnector.fetchRecord(ref, withSituacao("Em Andamento"), evRecent)).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(camaraConnector.fetchRecord(ref, withSituacao("Em Andamento"), evOld)).rejects.toThrow(
      new RecordNotFoundError("The Câmara record of this session isn't complete yet. Try again later."),
    );
    await expect(camaraConnector.fetchRecord(ref, withSituacao("Cancelada"), ctx)).rejects.toThrow(new RecordNotFoundError("This Câmara session was cancelled or never confirmed."));
  });
  it("camara day whose plenary hasn't ended: waits when recent, a day wording when old", async () => {
    const open = fakeCamaraFetch({ eventos: () => new Response(JSON.stringify({ dados: [{ id: 82635, situacao: "Convocada", orgaos: [{ sigla: "PLEN" }] }], links: [] }), { status: 200 }) }).f;
    const ref = (date: string) => ({ chamber: "camara" as const, date, url: "x" });
    await expect(camaraConnector.fetchRecord(ref(daysAgo(1)), open, ctx)).rejects.toBeInstanceOf(RecordNotPublishedError);
    await expect(camaraConnector.fetchRecord(ref(daysAgo(5)), open, ctx)).rejects.toThrow(new RecordNotFoundError("The Câmara record of that date isn't complete yet. Try again later."));
  });
});
