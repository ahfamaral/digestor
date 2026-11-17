"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CHAMBERS, parseRecordRef, type RecordRef, recordInputError, type ChamberId, type RecordStatus } from "@digestor/core";
import { errorMessage } from "@/lib/http";
import { t } from "@/lib/i18n";
import { readableRecordDate, recordMatchedLine } from "@/lib/names";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { holdsLink, RecordHouseSelect, recordHelpText, useRecordHouse } from "./RecordHouseSelect";
import { Busy, Spinner } from "@/components/ui/spinner";

const BTN =
  "inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";
const POLL_MS = 3000;
/** A waiting row only turns pending when its retry is due (hourly sweep): no need to ask every 3 s. */
const WAITING_POLL_MS = 60_000;
export const recordPollMs = (status: string | undefined) => (status === "waiting" ? WAITING_POLL_MS : POLL_MS);
/** Every RecordLink of the page (the context check's and Who's who's) re-reads the row when one of them changed it. */
const CHANGED = "digestor:record-changed";
type Focus = "input" | "status";

type RecordState = { status: RecordStatus; error: string | null; chamber?: ChamberId; date: string | null; url: string; retryAt?: string | null; /** Only for a `suggested` row: the ref the journalist is shown. */ ref?: RecordRef };

/** An HTTP failure whose message is the server's friendly sentence. */
class HttpError extends Error {}

/** The client-side check of the field: a friendly sentence, or null when the text is a record of the picked house (or a link to one). */
export function recordFieldError(text: string, chamber?: ChamberId): string | null {
  return recordInputError(text, chamber) ?? (parseRecordRef(text, chamber) ? null : t("record.invalid"));
}

/** "This looks like the Bundestag sitting of 16 Oct 2026." (a Bundestag ref with no date yet reads "…sitting 104."). */
function suggestionLine(record: RecordState): string {
  const house = CHAMBERS[record.chamber ?? "senado"].shortName;
  const sitting = record.ref?.chamber === "bundestag" ? record.ref.sitting : null;
  if (!record.date && sitting) return t("names.record.suggestedSitting", { house, sitting: String(sitting) });
  return t("names.record.suggested", { house, date: record.date ? readableRecordDate(record.date, record.chamber) : "" });
}

/** A suggestion shows only while the session is a parliament one (the row stays, and comes back if the profile does). It needs its ref: that is what the buttons send. */
export function suggestionShown(record: RecordState | null, profile?: string): boolean {
  return record?.status === "suggested" && !!record.ref && profile === "parliament";
}

/** The suggested record of the YouTube details: its line and the two buttons. */
export function RecordSuggestion({ record, busy, onAccept, onDismiss }: { record: RecordState; busy: boolean; onAccept: () => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p role="status" className="text-foreground">{suggestionLine(record)}</p>
      <div className="flex gap-1.5">
        <button type="button" className={BTN} disabled={busy} onClick={onAccept}>
          {t("names.record.useSuggestion")}
        </button>
        <button type="button" className={BTN} disabled={busy} onClick={onDismiss}>
          {t("names.record.dismissSuggestion")}
        </button>
      </div>
    </div>
  );
}

/** The status line of a linked record. A waiting row shows the line the worker stored; pending/running say it is matching. */
export function RecordStatusLine({ record }: { record: RecordState }) {
  return (
    <>
    {record.status === "pending" || record.status === "running" ? (
      <p role="status" className="inline-flex items-center gap-1.5 text-muted-foreground"><Spinner />{t("names.record.matching")}</p>
    ) : record.status === "matched" ? (
      <p role="status" className="text-foreground">{recordMatchedLine(record)}</p>
    ) : record.status === "waiting" && record.chamber ? (
      <p role="status" className="text-muted-foreground">
        {record.error ?? t("names.record.waiting", { house: CHAMBERS[record.chamber].shortName, date: record.date ?? "" })}
      </p>
    ) : record.status === "suggested" && record.chamber ? (
      <p role="status" className="text-foreground">{suggestionLine(record)}</p>
    ) : (
      <p role="status" dir="auto" className="text-red-700">{record.error ?? t("names.record.failed")}</p>
    )}
    </>
  );
}

/**
 * The official-record line of Who's who: the status of the linked record (Câmara, Senado, Bundestag, House or Senate) (matching, matched with its date, or the
 * friendly failure) and a field to link or re-link one. Shown for parliament sessions and whenever a record is linked.
 * Polls while the record is matched in the worker, then refreshes the names.
 */
export function RecordLink({
  sessionId,
  profile,
  suggestionOnly = false,
  suggestionElsewhere = false,
}: {
  sessionId: string;
  profile?: string;
  /** The context check's copy: only the open suggestion, nothing else. */
  suggestionOnly?: boolean;
  /** Who's who inside the context check: the page shows the open suggestion above the form, so this copy stays hidden while it is open. */
  suggestionElsewhere?: boolean;
}) {
  const router = useRouter();
  const [record, setRecord] = useState<RecordState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [house, pickHouse, showHouse] = useRecordHouse();
  const id = useId();
  const seen = useRef<RecordStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const [wantFocus, setWantFocus] = useState<Focus | null>(null);

  const load = useEffectEvent(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/record`);
      if (!res.ok) return;
      const next = (await res.json()) as RecordState | null;
      const was = seen.current;
      seen.current = next?.status ?? null;
      setRecord(next);
      // A match that just finished wrote names: re-read the page's data.
      if ((was === "pending" || was === "running" || was === "waiting") && next?.status === "matched") router.refresh();
    } catch {
      // a dropped poll: the next one retries
    } finally {
      setLoaded(true);
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [sessionId]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      if (e instanceof CustomEvent && (e as CustomEvent<{ from: string }>).detail?.from === id) return;
      const focus = (e as CustomEvent<{ focus?: Focus }>).detail?.focus;
      if (focus && !suggestionOnly) setWantFocus(focus);
      void load();
    };
    window.addEventListener(CHANGED, onChanged);
    return () => window.removeEventListener(CHANGED, onChanged);
  }, [sessionId, suggestionOnly, id]);
  // Focus follows the answer: the opened field after "Not this one", the status line after "Use this record".
  useEffect(() => {
    if (!wantFocus) return;
    const el = wantFocus === "input" ? inputRef.current : statusRef.current;
    if (!el) return;
    el.focus();
    setWantFocus(null);
  }, [wantFocus, record]);

  const working = record?.status === "pending" || record?.status === "running";
  const polling = working || record?.status === "waiting"; // a waiting row turns pending when its retry is due
  const pollMs = recordPollMs(record?.status);
  useEffect(() => {
    if (!polling) return;
    return startRefreshLoop(() => void load(), pollMs);
  }, [polling, pollMs, sessionId]);

  async function link() {
    if (busy) return;
    const invalid = recordFieldError(text, house || undefined);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: text.trim(), chamber: house || undefined }),
      });
      if (!res.ok) throw new HttpError(await errorMessage(res, t("names.record.failed")));
      setText("");
      setEditing(false);
      // The poll (running while pending) follows the job from here.
      seen.current = "pending";
      setRecord({ status: "pending", error: null, date: null, url: "", retryAt: null });
    } catch (err) {
      console.error("record: link failed", err);
      setError(err instanceof HttpError ? err.message : t("names.record.failed"));
    } finally {
      setBusy(false);
    }
  }

  const notify = (focus: Focus) => {
    if (!suggestionOnly) setWantFocus(focus);
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: { from: id, focus } }));
  };

  /** "Use this record" (accept) or "Not this one" (dismiss) for the suggestion the journalist saw. */
  async function answer(action: "accept" | "dismiss") {
    if (busy || !record?.ref) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ref: record.ref }),
      });
      if (!res.ok) throw new HttpError(await errorMessage(res, t("names.record.failed")));
      if (action === "dismiss") {
        // The row is gone: the field to link a record opens in its place.
        seen.current = null;
        setRecord(null);
        setEditing(false);
        notify("input");
      } else {
        seen.current = "pending";
        setRecord({ status: "pending", error: null, chamber: record.chamber, date: record.date, url: record.url, retryAt: null });
        notify("status");
      }
    } catch (err) {
      console.error("record: suggestion answer failed", err);
      setError(err instanceof HttpError ? err.message : t("names.record.failed"));
    } finally {
      setBusy(false);
    }
  }

  // A suggestion for a session that is not a parliament one stays stored but unseen.
  const hidden = record?.status === "suggested" && !suggestionShown(record, profile);
  if (!loaded || hidden || (!record && profile !== "parliament")) return null;
  const suggesting = suggestionShown(record, profile);
  if (suggesting && suggestionElsewhere) return null;
  if (suggestionOnly) {
    return suggesting && record ? (
      <div className="rounded-lg border border-border bg-stone-50 px-3 py-2 text-sm">
        <RecordSuggestion record={record} busy={busy} onAccept={() => void answer("accept")} onDismiss={() => void answer("dismiss")} />
        {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
    ) : null;
  }
  const showField = !record || editing;
  return (
    <div ref={statusRef} tabIndex={-1} className="mb-3 rounded-lg border border-border bg-stone-50 px-3 py-2 text-sm outline-none">
      {record && suggesting && <RecordSuggestion record={record} busy={busy} onAccept={() => void answer("accept")} onDismiss={() => void answer("dismiss")} />}
      {record && !suggesting && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <RecordStatusLine record={record} />
          {!editing && (
            <button type="button" className={BTN} onClick={() => setEditing(true)}>
              {t("names.record.relink")}
            </button>
          )}
        </div>
      )}
      {showField && (
        <form
          className={record ? "mt-2" : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void link();
          }}
        >
          <label htmlFor={`record-${sessionId}`} className="block text-xs font-semibold">
            {t("names.record.label")}
          </label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <RecordHouseSelect
              id={`record-house-${sessionId}`}
              value={house}
              disabled={busy}
              describedBy={`record-help-${sessionId}`}
              onChange={(next) => {
                pickHouse(next);
                setError(null);
              }}
            />
            <input
              id={`record-${sessionId}`}
              ref={inputRef}
              value={text}
              disabled={busy}
              placeholder={t("names.record.placeholder")}
              aria-describedby={`record-help-${sessionId}`}
              aria-invalid={error !== null}
              onChange={(e) => {
                setText(e.target.value);
                if (holdsLink(e.target.value)) showHouse("");
                setError(null);
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            <button type="submit" className={BTN} disabled={busy || text.trim() === ""}>
              <Busy busy={busy}>{busy ? t("names.record.linking") : t("names.record.link")}</Busy>
            </button>
          </div>
          <p id={`record-help-${sessionId}`} className="mt-1 text-xs text-muted-foreground">
            {recordHelpText(house)}
          </p>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
