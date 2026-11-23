"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { formatLength, formatTimestamp, type AskAction, type ClipFormat, type ToolApprovalCall, type ToolApprovalResolution } from "@digestor/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Busy } from "@/components/ui/spinner";
import { draftRange, initialPackageDraft, packageDecision, type PackageDraft } from "@/lib/askText";
import { subtitleLanguages } from "@/lib/prepareData";
import { t } from "@/lib/i18n";
import { aboutUsd, packageCostUsd } from "@/lib/cost";

const SELECT =
  "h-8 w-full min-w-0 rounded-md border border-border bg-white px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground";

/**
 * A clip package waiting for the journalist (`make_clip_package`): this card is the pick. Each offered clip has a
 * checkbox (all ticked), its times and title can be edited, and one format and subtitle language apply to all.
 * "Make N clips" approves as is, or sends the picks as an edit; Reject makes nothing. Once decided, it says so.
 */
export function PackageCard({
  action, call, outcome, sessionId, lang, busy, error, videoRemoved, onDecide,
}: {
  action: AskAction;
  /** What the tool did, from its record on the answer (null until it ran): the decided line never claims more. */
  outcome: { ok: boolean; made: number } | null;
  call: ToolApprovalCall & { package: NonNullable<ToolApprovalCall["package"]> };
  sessionId: string | undefined;
  /** The video's language: titles are in it, and it is the first subtitle language offered. */
  lang: string | undefined;
  busy: boolean;
  error: string | undefined;
  videoRemoved: boolean;
  onDecide: (action: AskAction, resolution: ToolApprovalResolution) => void;
}) {
  const headingId = useId();
  const baseId = useId();
  const [initial] = useState<PackageDraft>(() => initialPackageDraft(call.package));
  const [draft, setDraft] = useState<PackageDraft>(initial);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** The clip the error is about: only its fields are marked invalid. */
  const [badIndex, setBadIndex] = useState<number | null>(null);

  const picked = draft.clips.filter((c) => c.on).length;
  const languages = subtitleLanguages(lang ?? null, []);
  const setClip = (i: number, patch: Partial<PackageDraft["clips"][number]>) => {
    setEditError(null); // a change answers the error; "Make N clips" checks again
    setBadIndex(null);
    setDraft((d) => ({ ...d, clips: d.clips.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const out = packageDecision(call.id, draft, initial);
    if ("error" in out) {
      setEditError(
        out.error === "none" ? t("ask.package.errorNone") : out.error === "length" ? t("ask.package.errorLength") : t(`ask.approval.error.${out.error}`),
      );
      setBadIndex(out.index ?? null);
      if (out.error !== "none") setEditing(true);
      return;
    }
    setEditError(null);
    setBadIndex(null);
    onDecide(action, out);
  }

  // What is being made: the card's picks when the journalist edited it, else the package as offered.
  const resolution = action.resolution as { decision?: string; edits?: { args?: { clips?: unknown[]; format?: unknown; subtitles?: unknown } }[] } | null;
  const edited = resolution?.decision === "edit" ? resolution.edits?.[0]?.args : undefined;
  const madeCount = outcome?.ok ? outcome.made : Array.isArray(edited?.clips) ? edited.clips.length : call.package.clips.length;
  const madeFormat = edited?.format === "16:9" || edited?.format === "9:16" ? edited.format : call.package.format;
  const madeLanguage = edited ? (typeof edited.subtitles === "string" ? edited.subtitles : null) : call.package.subtitles;
  const details = madeLanguage
    ? t("ask.package.detailsDrafts", { format: madeFormat, language: languages.find((l) => l.code === madeLanguage)?.label ?? madeLanguage })
    : madeFormat;
  const pending = action.status === "pending";
  const disabled = busy || videoRemoved;

  return (
    <div role="group" aria-labelledby={headingId} className="grid gap-2 rounded-lg border border-border bg-stone-50 p-2">
      <p id={headingId} className="text-xs font-semibold">
        {t("ask.package.title")}
      </p>
      {!pending ? (
        <>
          <p lang={lang} dir="auto" className="break-words text-xs">
            {call.summary}
          </p>
          {action.status === "dismissed" ? (
            <p className="text-xs text-muted-foreground">{t("ask.approval.declined")}</p>
          ) : outcome && !outcome.ok ? (
            <p className="text-xs text-red-700">
              {outcome.made === 0
                ? t("ask.package.notMade")
                : outcome.made === 1
                  ? t("ask.package.partlyMade", { n: 1 })
                  : t("ask.package.partlyMadeMany", { n: outcome.made })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {madeCount === 1 ? t("ask.package.madeOne", { details }) : t("ask.package.made", { n: madeCount, details })}{" "}
              {sessionId && (
                <Link href={`/s/${sessionId}/prepare`} className="font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  {t("ask.package.openPrepare")}
                </Link>
              )}
            </p>
          )}
        </>
      ) : (
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <p className="text-xs text-muted-foreground">{draft.subtitles ? t("ask.package.helpDrafts") : t("ask.package.help")}</p>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium">{t("ask.package.clips")}</legend>
            {draft.clips.map((c, i) => {
              const offered = call.package.clips[i]!;
              // The row follows the edited times, so the journalist sees the range and length they will get.
              const shown = draftRange(c, offered);
              const range = `${formatTimestamp(shown.startMs)}–${formatTimestamp(shown.endMs)}`;
              return (
                // While editing, each clip is its own white block (checkbox line, then its fields), so 5 clips stay readable.
                <div
                  key={i}
                  role="group"
                  aria-label={t("ask.package.clipN", { n: i + 1 })}
                  className={editing ? "grid min-w-0 gap-2 rounded-md border border-border bg-white p-2" : "grid gap-1.5"}
                >
                  <label className="flex items-start gap-2 text-xs">
                    <Checkbox checked={c.on} disabled={disabled} onCheckedChange={(on) => setClip(i, { on: on === true })} className="mt-0.5" />
                    <span className="min-w-0 break-words">
                      <span dir="ltr" className="font-mono text-muted-foreground">
                        {t("ask.package.clipLabel", { range, length: formatLength(shown.endMs - shown.startMs) })}
                      </span>{" "}
                      <span lang={lang} dir="auto">
                        {c.title.trim() || offered.title}
                      </span>
                    </span>
                  </label>
                  {editing && c.on && (
                    <div className="grid min-w-0 gap-2">
                      <div className="grid grid-cols-2 gap-2">
                        {(["start", "end"] as const).map((key) => (
                          <label key={key} className="grid min-w-0 gap-1 text-xs font-medium">
                            {t(`ask.approval.${key}`)}
                            <Input
                              value={c[key]}
                              disabled={disabled}
                              inputMode="numeric"
                              placeholder="hh:mm:ss"
                              aria-invalid={editError !== null && badIndex === i}
                              onChange={(e) => setClip(i, { [key]: e.target.value })}
                              className="h-8 bg-white font-mono text-xs"
                            />
                          </label>
                        ))}
                      </div>
                      <label className="grid gap-1 text-xs font-medium">
                        {t("ask.approval.clipTitle")}
                        <Input
                          value={c.title}
                          disabled={disabled}
                          maxLength={120}
                          lang={lang}
                          dir="auto"
                          onChange={(e) => setClip(i, { title: e.target.value })}
                          className="h-8 bg-white text-xs"
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
          {!videoRemoved && (
            <div>
              <Button type="button" size="sm" variant="outline" disabled={busy} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
                {editing ? t("ask.package.hideTimes") : t("ask.package.editTimes")}
              </Button>
              {editing && <p className="mt-1 text-xs text-muted-foreground">{t("ask.approval.snapHint")}</p>}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-xs font-medium">{t("ask.package.format")}</legend>
              {(["9:16", "16:9"] as ClipFormat[]).map((f) => (
                <label key={f} className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name={`${baseId}-format`}
                    value={f}
                    checked={draft.format === f}
                    disabled={disabled}
                    onChange={() => setDraft((d) => ({ ...d, format: f }))}
                    className="size-3.5 accent-brand"
                  />
                  {f === "9:16" ? t("ask.package.formatTall") : t("ask.package.formatWide")}
                </label>
              ))}
            </fieldset>
            <label className="grid content-start gap-1 text-xs font-medium">
              {t("ask.package.subtitles")}
              <select
                value={draft.subtitles ?? ""}
                disabled={disabled}
                onChange={(e) => setDraft((d) => ({ ...d, subtitles: e.target.value === "" ? null : e.target.value }))}
                className={SELECT}
              >
                <option value="">{t("ask.package.noSubtitles")}</option>
                {/* A language the model chose that the list lacks still shows (the worker checked it). */}
                {draft.subtitles !== null && !languages.some((l) => l.code === draft.subtitles) && <option value={draft.subtitles}>{draft.subtitles}</option>}
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {editError && (
            <p role="alert" className="text-xs text-red-700">
              {editError}
            </p>
          )}
          {!videoRemoved && picked > 0 && (
            <p className="text-xs text-muted-foreground">
              {(() => {
                const usd = packageCostUsd(draft.clips, call.package.clips, draft.subtitles, lang);
                return usd > 0 ? t("cost.package", { cost: aboutUsd(usd) }) : t("cost.packageFree");
              })()}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!videoRemoved && (
              <Button type="submit" size="sm" disabled={busy || picked === 0} className="bg-brand text-white hover:brightness-90 active:brightness-[0.82]">
                <Busy busy={busy}>
                  {busy ? t("ask.approval.sending") : picked === 0 ? t("ask.package.tickOne") : picked === 1 ? t("ask.package.makeOne") : t("ask.package.make", { n: picked })}
                </Busy>
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecide(action, { decision: "reject" })}>
              {t("ask.approval.reject")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
