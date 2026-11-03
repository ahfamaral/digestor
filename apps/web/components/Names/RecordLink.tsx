"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRecordRef, type RecordStatus } from "@digestor/core";
import { errorMessage } from "@/lib/http";
import { t } from "@/lib/i18n";
import { recordMatchedLine } from "@/lib/names";
import { startRefreshLoop } from "@/lib/refreshLoop";

const BTN =
  "inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";
const POLL_MS = 3000;

type RecordState = { status: RecordStatus; error: string | null; chamber?: "senado" | "camara"; date: string | null; url: string };

/** An HTTP failure whose message is the server's friendly sentence. */
class HttpError extends Error {}

/** The client-side check of the field: a friendly sentence, or null when the text is a Senado or Câmara ref. */
export function recordFieldError(text: string): string | null {
  return parseRecordRef(text) ? null : t("record.invalid");
}

/**
 * The official-record line of Who's who: the status of the linked Senado or Câmara record (matching, matched with its date, or the
 * friendly failure) and a field to link or re-link one. Shown for parliament sessions and whenever a record is linked.
 * Polls while the record is matched in the worker, then refreshes the names.
 */
export function RecordLink({ sessionId, profile }: { sessionId: string; profile?: string }) {
  const router = useRouter();
  const [record, setRecord] = useState<RecordState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<RecordStatus | null>(null);

  const load = useEffectEvent(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/record`);
      if (!res.ok) return;
      const next = (await res.json()) as RecordState | null;
      const was = seen.current;
      seen.current = next?.status ?? null;
      setRecord(next);
      // A match that just finished wrote names: re-read the page's data.
      if ((was === "pending" || was === "running") && next?.status === "matched") router.refresh();
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

  const working = record?.status === "pending" || record?.status === "running";
  useEffect(() => {
    if (!working) return;
    return startRefreshLoop(() => void load(), POLL_MS);
  }, [working, sessionId]);

  async function link() {
    if (busy) return;
    const invalid = recordFieldError(text);
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
        body: JSON.stringify({ ref: text.trim() }),
      });
      if (!res.ok) throw new HttpError(await errorMessage(res, t("names.record.failed")));
      setText("");
      setEditing(false);
      // The poll (running while pending) follows the job from here.
      seen.current = "pending";
      setRecord({ status: "pending", error: null, date: null, url: "" });
    } catch (err) {
      console.error("record: link failed", err);
      setError(err instanceof HttpError ? err.message : t("names.record.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || (!record && profile !== "parliament")) return null;
  const showField = !record || editing;
  return (
    <div className="mb-3 rounded-lg border border-border bg-stone-50 px-3 py-2 text-sm">
      {record && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {working ? (
            <p role="status" className="text-muted-foreground">{t("names.record.matching")}</p>
          ) : record.status === "matched" ? (
            <p role="status" className="text-foreground">{recordMatchedLine(record)}</p>
          ) : (
            <p role="status" dir="auto" className="text-red-700">{record.error ?? t("names.record.failed")}</p>
          )}
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
            <input
              id={`record-${sessionId}`}
              value={text}
              disabled={busy}
              placeholder={t("names.record.placeholder")}
              aria-describedby={`record-help-${sessionId}`}
              aria-invalid={error !== null}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            <button type="submit" className={BTN} disabled={busy || text.trim() === ""}>
              {busy ? t("names.record.linking") : t("names.record.link")}
            </button>
          </div>
          <p id={`record-help-${sessionId}`} className="mt-1 text-xs text-muted-foreground">
            {t("names.record.help")}
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
