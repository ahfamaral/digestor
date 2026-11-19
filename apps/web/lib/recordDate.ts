import type { Attribution, RecordRef, RecordStatus } from "@digestor/core";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day of the session's linked official record (`YYYY-MM-DD`), for the context check's Date field; null when it
 * isn't known. A ref that carries its date (Senado, a Câmara day, US houses, a dated Bundestag sitting) gives it as
 * soon as it is linked; a Câmara event link carries none, so once matched the event date its live record names keep
 * (`evidence.date`) is used. A suggestion the journalist hasn't accepted, or a record that failed, gives nothing.
 */
export function contextRecordDate(record: { status: RecordStatus; ref: RecordRef } | null, attributions: Attribution[]): string | null {
  if (!record || record.status === "suggested" || record.status === "failed") return null;
  const own = "date" in record.ref ? record.ref.date : null;
  if (own) return ISO_DATE.test(own) ? own : null;
  if (record.status !== "matched") return null;
  for (const a of attributions) {
    const e = a.evidence;
    if (a.source === "record" && a.supersededAt === null && a.status !== "rejected" && e.kind === "record" && e.date && ISO_DATE.test(e.date)) return e.date;
  }
  return null;
}

/** The Date field with the record's day filled in: only when the field is empty and no date was stored. */
export function prefillDate(current: string, stored: string, recordDate: string | null): string {
  return recordDate && !current.trim() && !stored.trim() ? recordDate : current;
}
