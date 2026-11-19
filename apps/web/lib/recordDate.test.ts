import { describe, expect, it } from "vitest";
import type { Attribution, RecordRef } from "@digestor/core";
import { contextRecordDate, prefillDate } from "./recordDate";

const senado: RecordRef = { chamber: "senado", date: "2026-10-21", sessionCode: null, url: "https://legis.senado.leg.br/x" };
const event: RecordRef = { chamber: "camara", eventId: "79123", url: "https://www.camara.leg.br/evento-legislativo/79123" };

function att(over: Partial<Attribution> & { date?: string }): Attribution {
  const { date, ...rest } = over;
  return {
    id: "a1", sessionId: "s", speakerId: "A", startMs: 0, endMs: 1000, personId: "p", source: "record", status: "proposed", confidence: 0.9,
    evidence: { kind: "record", speechId: "1", score: 0.9, url: event.url, fetchedAt: "t", chamber: "camara", ...(date ? { date } : {}) },
    createdBy: "ai", createdAt: new Date(), supersededAt: null, ...rest,
  } as Attribution;
}

describe("contextRecordDate", () => {
  it("is the linked ref's own date, for every house that stores one", () => {
    expect(contextRecordDate({ status: "pending", ref: senado }, [])).toBe("2026-10-21");
    expect(contextRecordDate({ status: "matched", ref: { chamber: "camara", date: "2026-03-10", url: "u" } }, [])).toBe("2026-03-10");
    expect(contextRecordDate({ status: "waiting", ref: { chamber: "us_house", date: "2026-02-03", url: "u" } }, [])).toBe("2026-02-03");
    expect(contextRecordDate({ status: "running", ref: { chamber: "bundestag", period: 21, sitting: null, date: "2026-01-15", url: "u" } }, [])).toBe("2026-01-15");
  });

  it("a Câmara event link carries no date: once matched, the event date its record names kept", () => {
    expect(contextRecordDate({ status: "pending", ref: event }, [])).toBeNull();
    expect(contextRecordDate({ status: "matched", ref: event }, [att({ date: "2026-04-08" })])).toBe("2026-04-08");
    // only live record rows count: a superseded (another record's) or rejected row says nothing
    expect(contextRecordDate({ status: "matched", ref: event }, [att({ date: "2026-04-08", supersededAt: new Date() })])).toBeNull();
    expect(contextRecordDate({ status: "matched", ref: event }, [att({ date: "2026-04-08", status: "rejected" })])).toBeNull();
    expect(contextRecordDate({ status: "matched", ref: event }, [att({})])).toBeNull();
    expect(contextRecordDate({ status: "matched", ref: event }, [att({ date: "8 April" })])).toBeNull();
    // a Bundestag sitting number without a date
    expect(contextRecordDate({ status: "pending", ref: { chamber: "bundestag", period: 21, sitting: 12, date: null, url: "u" } }, [])).toBeNull();
  });

  it("no record, a suggestion the journalist hasn't accepted, or a failed record: no date", () => {
    expect(contextRecordDate(null, [])).toBeNull();
    expect(contextRecordDate({ status: "suggested", ref: senado }, [])).toBeNull();
    expect(contextRecordDate({ status: "failed", ref: senado }, [])).toBeNull();
  });
});

describe("prefillDate", () => {
  it("fills only an empty field whose stored date is empty too", () => {
    expect(prefillDate("", "", "2026-10-21")).toBe("2026-10-21");
    expect(prefillDate("  ", "", "2026-10-21")).toBe("2026-10-21");
    expect(prefillDate("last spring", "", "2026-10-21")).toBe("last spring"); // typed by the journalist
    expect(prefillDate("2025", "2025", "2026-10-21")).toBe("2025"); // already stored
    expect(prefillDate("", "", null)).toBe("");
  });
});
