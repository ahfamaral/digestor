import { describe, expect, it } from "vitest";
import { parseCsv, toBillAuthors, toBills, toOrientations, toPresence, toSessions } from "./bulk.js";
import { monitorFixture } from "./fakeCamaraMonitor.js";

const csv = (kind: string, keep?: string[]) => parseCsv(monitorFixture(`${kind}-2026.excerpt.csv`), keep);

describe("parseCsv", () => {
  it("strips the BOM and keeps line breaks inside quoted fields", () => {
    expect(parseCsv('﻿"a";"b"\n"1";"x\r\ny"\n')).toEqual([{ a: "1", b: "x\r\ny" }]);
  });

  it("with keep, leaves only the named columns", () => {
    expect(parseCsv('﻿"a";"b";"c"\n"1";"2";"3"\n', ["a", "c"])).toEqual([{ a: "1", c: "3" }]);
    const rows = csv("proposicoes", ["id", "siglaTipo", "dataApresentacao"]);
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0]!).sort()).toEqual(["dataApresentacao", "id", "siglaTipo"]);
  });
});

describe("toOrientations", () => {
  it("groups the guidance of the asked roll calls, trimmed, empty kept", () => {
    const m = toOrientations(csv("votacoesOrientacoes"), new Set(["2449741-72"]));
    expect([...m.keys()]).toEqual(["2449741-72"]);
    const rows = m.get("2449741-72")!;
    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({ bloc: "Bl UniPpPsd...", orientation: "Sim" });
    expect(rows).toContainEqual({ bloc: "Governo", orientation: "" });
    expect(rows).toContainEqual({ bloc: "Fdr PSOL-REDE", orientation: "Sim" });
  });

  it("knows nothing of a roll call it wasn't asked about", () => {
    expect(toOrientations(csv("votacoesOrientacoes"), new Set(["1-1"])).size).toBe(0);
  });
});

describe("toSessions", () => {
  it("keeps plenary deliberative sessions of every status; a committee meeting is not a session", () => {
    expect(toSessions(csv("eventos"))).toEqual([
      { id: 83243, startsAt: "2026-11-10T14:03", description: expect.any(String), status: "Encerrada" },
      { id: 83188, startsAt: "2026-11-05T11:07", description: expect.any(String), status: "Encerrada" },
      { id: 82553, startsAt: "2026-06-18T10:00", description: expect.any(String), status: "Cancelada" },
    ]);
  });
});

describe("toPresence", () => {
  it("keeps presence at the given sessions only", () => {
    const rows = toPresence(csv("eventosPresencaDeputados"), new Set([83243, 83188, 82553]));
    expect(rows.filter((r) => r.externalId === 204407).map((r) => r.sessionId).sort()).toEqual([83188, 83243]);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.sessionId === 80841)).toBe(false);
  });
});

describe("toBills", () => {
  it("maps bills presented since 1 Feb 2026; a January bill is dropped", () => {
    const rows = toBills(csv("proposicoes"));
    expect(rows.map((r) => r.id)).toEqual([2600034, 2646307, 2652548]);
    expect(rows[0]).toEqual({
      id: 2600034, type: "RCP", number: 1, year: 2026,
      summary: expect.stringMatching(/^Requer a criação de Comissão Parlamentar de Inquérito/),
      presentedAt: "2026-02-02T09:54",
    });
  });
});

describe("toBillAuthors", () => {
  it("keeps deputies' authorship of the given bills; a committee author is skipped", () => {
    const rows = toBillAuthors(csv("proposicoesAutores"), new Set([2600034, 2646307, 2652548]));
    expect(rows).toEqual([
      { billId: 2600034, externalId: 204488, firstAuthor: false },
      { billId: 2600034, externalId: 141533, firstAuthor: true },
      { billId: 2646307, externalId: 204407, firstAuthor: true },
    ]);
  });
});
