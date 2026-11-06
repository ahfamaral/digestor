"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMinSec, formatTimestamp } from "@digestor/core";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/http";
import { anonymousBody, conflictText, confirmBody, evidenceLine, personDetail, rowRange, rowRanges, visibleWhoRows, voiceLabel, type NamesData, type WhosWhoRow } from "@/lib/names";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WARNING_BOX, WarningIcon } from "@/components/WarningNote";
import { sampleSrc } from "@/lib/media";
import { usePauseWhenHidden } from "@/lib/usePauseWhenHidden";
import { t } from "@/lib/i18n";
import { NamePopover } from "./NamePopover";
import { RecordLink } from "./RecordLink";
import { SpeakerName } from "./SpeakerName";
import { Busy } from "@/components/ui/spinner";

const BTN =
  "inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";
const SAMPLE_MS = 5000;

/** An HTTP failure whose message is the server's friendly sentence. */
class HttpError extends Error {}

/** The caption frame lives at `<sessionId>/names/<frame>.jpg`; the files route serves the last segment. */
function frameUrl(sessionId: string, frameKey: string): string {
  const file = frameKey.split("/").pop() ?? frameKey;
  return `/api/files/${sessionId}/names/${encodeURIComponent(file.replace(/\.jpg$/i, ""))}.jpg`;
}

function Evidence({ sessionId, row }: { sessionId: string; row: WhosWhoRow }) {
  const res = row.resolution;
  if (res.kind !== "named") return null;
  const e = res.attribution.evidence;
  return (
    <div className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
      {e.kind === "caption" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frameUrl(sessionId, e.frameKey)}
          alt={t("names.frameAlt", { text: e.text })}
          loading="lazy"
          className="h-12 w-20 shrink-0 rounded border border-border bg-stone-100 object-cover"
        />
      )}
      <span dir="auto" className="min-w-0 break-words">
        {evidenceLine(res.attribution)}
        {!res.confirmed && ` · ${t("names.unconfirmed")}`}
      </span>
    </div>
  );
}

/**
 * The Who's who panel: one row per voice and name, with a short sample to hear, the name and its source, the
 * evidence, and Confirm / Change… / No name. Used in the context check (`mode="context"`) and in the drawer.
 */
export function WhosWho({
  sessionId,
  rows,
  names,
  sensitive,
  language,
  mode,
  profile,
  videoRemoved = false,
  proxyReady = true,
  speakerQuestions,
  answers,
  onAnswer,
  blocking,
}: {
  sessionId: string;
  rows: WhosWhoRow[];
  names: NamesData;
  sensitive: boolean;
  language?: string;
  mode: "context" | "drawer";
  /** The session's profile: a parliament session offers the official-record field. */
  profile?: string;
  /** Retention removed the video (and its proxy): no ▶ samples. */
  videoRemoved?: boolean;
  /** The 360p preview copy exists (always, once the session is `ready`); until then the samples play from the audio. */
  proxyReady?: boolean;
  /**
   * Context check only: the agent's "Who is speaker B?" questions, by voice. Each is answered in the voice's own row
   * (its first one) and the answer goes with Continue like any other answer.
   */
  speakerQuestions?: Record<string, { id: string; question: string; why: string }>;
  answers?: Record<string, string>;
  onAnswer?: (questionId: string, answer: string) => void;
  /** The voices that block clips (speaker id to clips blocked): always listed, first, and marked. */
  blocking?: Record<string, number>;
}) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "No name" asks first: the row it applies to, and its label, are fixed when the button is clicked.
  const [noName, setNoName] = useState<{ row: WhosWhoRow; text: string; named: boolean } | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  usePauseWhenHidden(player);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
    },
    [],
  );

  function hear(startMs: number) {
    const v = player.current;
    if (!v) return;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    v.currentTime = startMs / 1000;
    void v.play().catch(() => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      setError(t("names.couldNotPlay"));
    });
    stopTimer.current = setTimeout(() => v.pause(), SAMPLE_MS);
  }

  async function send(body: Record<string, unknown>, opts: { rethrow?: boolean } = {}) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/names`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new HttpError(await errorMessage(res, t("names.failed")));
      router.refresh();
    } catch (err) {
      console.error("whos-who: save failed", err);
      const message = err instanceof HttpError ? err.message : t("names.failed");
      if (opts.rethrow) throw new Error(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const main = rows.filter((r) => r.main);
  const rest = rows.filter((r) => !r.main);
  const shown = visibleWhoRows(rows, { showAll, blocking, asked: new Set(Object.keys(speakerQuestions ?? {})) });
  const questionShownFor = new Set<string>();
  const proposed = rows.some((r) => r.resolution.kind === "named" && !r.resolution.confirmed);
  const totalMs = rows.reduce((a, r) => a + r.ms, 0);
  const noNameSpans = noName ? rowRanges(noName.row) : [];
  const noNameWhere =
    noNameSpans.length > 0
      ? `${formatTimestamp(Math.min(...noNameSpans.map((r) => r.startMs)))}–${formatTimestamp(Math.max(...noNameSpans.map((r) => r.endMs)))}`
      : t("names.noNameWhole");

  return (
    <div>
      {sensitive && (
        <p role="note" className={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${WARNING_BOX}`}>
          <WarningIcon className="mt-0.5" />
          <span>{t("names.whoSensitive")}</span>
        </p>
      )}
      <RecordLink sessionId={sessionId} profile={profile} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("names.whoEmpty")}</p>
      ) : (
        <>
          {proposed && (
            <div className="mb-2">
              <button type="button" className={BTN} disabled={busy} onClick={() => void send({ action: "confirm_all" })}>
                <Busy busy={busy}>{busy ? t("names.confirmAllBusy") : t("names.confirmAll")}</Busy>
              </button>
            </div>
          )}
          <ul aria-label={t("names.rowsLabel")} className="divide-y divide-border">
            {shown.map((row) => {
              const label = voiceLabel(names, row.speakerId, row.sampleStartMs, false);
              const res = row.resolution;
              const person = res.kind === "named" ? names.persons.find((p) => p.id === res.personId) : undefined;
              const range = rowRange(row) ?? undefined;
              const confirm = confirmBody(row);
              const conflict = conflictText(row, names);
              const detail = person ? personDetail(person, names.attributions) : "";
              const question = speakerQuestions?.[row.speakerId];
              const askHere = question !== undefined && !questionShownFor.has(row.speakerId);
              if (askHere) questionShownFor.add(row.speakerId);
              return (
                <li key={`${row.speakerId}-${res.kind === "named" ? res.personId : res.kind}`} className="py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {!videoRemoved && (
                      <button
                        type="button"
                        className={BTN}
                        aria-label={t("names.hearLabel", { label: label.text })}
                        onClick={() => hear(row.sampleStartMs)}
                      >
                        {t("names.hear")}
                      </button>
                    )}
                    <SpeakerName
                      speakerId={row.speakerId}
                      atMs={row.sampleStartMs}
                      names={names}
                      sensitive={false}
                      sessionId={sessionId}
                      language={language}
                      range={range}
                      ranges={row.ranges}
                      rangeOnly
                      confirmBody={confirm ?? undefined}
                      className="text-sm"
                    />
                    <span className="font-mono text-xs text-muted-foreground">
                      {t("names.speaking", { time: formatMinSec(row.ms), pct: Math.round((totalMs > 0 ? row.ms / totalMs : 0) * 100) })}
                    </span>
                  </div>
                  {(blocking?.[row.speakerId] ?? 0) > 0 && (
                    <div className="mt-1 text-xs font-medium text-stone-900">
                      {t(blocking![row.speakerId] === 1 ? "names.blocksOne" : "names.blocksMany", { n: blocking![row.speakerId]! })}
                    </div>
                  )}
                  {detail && (
                    <div dir="auto" className="mt-1 text-xs text-muted-foreground">
                      {detail}
                    </div>
                  )}
                  {conflict && (
                    <div dir="auto" className="mt-1 text-xs text-muted-foreground">
                      {conflict}. {t("names.conflictNote")}
                    </div>
                  )}
                  {res.kind === "unnamed" && <div className="mt-1 text-xs text-muted-foreground">{t("names.unnamedVoice")}</div>}
                  {res.kind === "anonymous" && <div className="mt-1 text-xs text-muted-foreground">{t("names.anonymousVoice")}</div>}
                  <Evidence sessionId={sessionId} row={row} />
                  {askHere && (
                    <label className="mt-2 block">
                      <span className="block text-sm font-semibold">{question.question}</span>
                      <span className="mb-1 block text-xs text-muted-foreground">{t("context.why", { why: question.why })}</span>
                      <input
                        aria-label={question.question}
                        className="h-8 w-full min-w-0 rounded-md border border-border bg-white px-2 text-sm outline-none focus:border-brand"
                        value={answers?.[question.id] ?? ""}
                        onChange={(e) => onAnswer?.(question.id, e.target.value)}
                      />
                    </label>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {confirm && (
                      <button type="button" className={BTN} disabled={busy} onClick={() => void send(confirm)}>
                        {t("names.confirm")}
                      </button>
                    )}
                    <NamePopover
                      sessionId={sessionId}
                      speakerId={row.speakerId}
                      label={label}
                      names={names}
                      range={range}
                      ranges={row.ranges}
                      rangeOnly
                      confirmBody={confirm ?? undefined}
                      startChanging
                      trigger={
                        <button type="button" className={BTN}>
                          {t("names.change")}
                        </button>
                      }
                    />
                    {res.kind !== "anonymous" && (
                      <button type="button" className={BTN} disabled={busy} onClick={() => setNoName({ row, text: label.text, named: label.badge !== null })}>
                        {t("names.noName")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {rest.length > 0 && main.length > 0 && (showAll || shown.length < rows.length) && (
            <button
              type="button"
              aria-expanded={showAll}
              className="mt-2 text-sm font-medium text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll ? t("names.showFewer") : t("names.showMore", { n: rows.length - shown.length })}
            </button>
          )}
        </>
      )}
      <ConfirmDialog
        open={noName !== null}
        onOpenChange={(next) => {
          if (!next) setNoName(null);
        }}
        title={noName ? t(noName.named ? "names.noNameTitle" : "names.noNameMarkTitle", { voice: noName.text }) : ""}
        description={
          noName ? t(noName.named ? "names.noNameBody" : "names.noNameMarkBody", { name: noName.text, voice: noName.text, where: noNameWhere }) : ""
        }
        actionLabel={t("names.noName")}
        busyLabel={t("names.saving")}
        onConfirm={() => (noName ? send(anonymousBody(noName.row), { rethrow: true }) : Promise.resolve())}
      />
      {error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {!videoRemoved && <video ref={player} src={sampleSrc(sessionId, proxyReady)} preload="none" className="hidden" data-mode={mode} />}
    </div>
  );
}

/** Who's who as a side drawer (the Briefing page). */
export function WhosWhoDrawer({
  open,
  onOpenChange,
  finalFocus,
  ...panel
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: React.RefObject<HTMLElement | null>;
} & Omit<React.ComponentProps<typeof WhosWho>, "mode">) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={finalFocus}
        showCloseButton
        className="top-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-md"
      >
        <div className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle>{t("names.whoTitle")}</DialogTitle>
          <DialogDescription className="mt-1 text-xs text-muted-foreground">{t("names.whoHint")}</DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <WhosWho {...panel} mode="drawer" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
