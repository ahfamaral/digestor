"use client";

import { useId, useState } from "react";
import { formatTimestamp, type AskAction, type StaleClip, type ToolApprovalCall, type ToolApprovalResolution } from "@digestor/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Busy } from "@/components/ui/spinner";
import { checkClipEdit, editHasClip, parseApprovalPayload, staleLine } from "@/lib/askText";
import { t } from "@/lib/i18n";
import { PackageCard } from "./PackageCard";

type ClipDraft = { start: string; end: string; title: string };
type Draft = Record<string, ClipDraft | string[]>;

/** One change's block in the Edit form. */
const BLOCK = "grid min-w-0 gap-2 rounded-md border border-border bg-white p-2";

const isClip = (call: ToolApprovalCall) => call.name === "propose_clip" || call.name === "trim_clip" || call.name === "replace_clip";

/** The edit fields' first values: the snapped range the summary shows, the model's title, every moment ticked. */
function initialDraft(calls: ToolApprovalCall[]): Draft {
  const draft: Draft = {};
  for (const call of calls) {
    const args = (call.args ?? {}) as { title?: unknown };
    if (isClip(call) && call.range) {
      draft[call.id] = {
        start: formatTimestamp(call.range.startMs),
        end: formatTimestamp(call.range.endMs),
        title: typeof args.title === "string" ? args.title : "",
      };
    } else if (call.name === "set_selection" && call.moments) {
      draft[call.id] = call.moments.map((m) => m.id);
    }
  }
  return draft;
}

/**
 * An Ask answer paused before changing clips or selections: one line per change, then Approve / Edit / Reject. The
 * card is itself the confirmation, so Approve and Reject ask nothing more; Edit opens the times and title of a clip
 * or the moments of a selection, then "Approve with changes". Once decided, it says so and the answer continues.
 */
export function ApprovalCard({
  action, outcome = null, sessionId, lang, busy, error, videoRemoved, onDecide,
}: {
  action: AskAction;
  /** A clip package's result from its tool record (`packageOutcome`), for the decided line. */
  outcome?: { ok: boolean; made: number } | null;
  /** For the package card's link to Prepare. */
  sessionId?: string;
  lang: string | undefined;
  busy: boolean;
  error: string | undefined;
  /** The video is gone: no change can be made any more, so only Reject is offered (it lets the answer finish). */
  videoRemoved: boolean;
  onDecide: (action: AskAction, resolution: ToolApprovalResolution) => void;
}) {
  const headingId = useId();
  const payload = parseApprovalPayload(action.payload);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [editError, setEditError] = useState<string | null>(null);
  if (!payload || payload.calls.length === 0) return null;
  const { calls } = payload;
  // A clip package on its own: the card is where the journalist picks the clips.
  const only = calls.length === 1 ? calls[0]! : null;
  if (only?.package) {
    return (
      <PackageCard action={action} call={{ ...only, package: only.package }} outcome={outcome} sessionId={sessionId} lang={lang} busy={busy} error={error} videoRemoved={videoRemoved} onDecide={onDecide} />
    );
  }
  const editable = calls.filter((c) => (isClip(c) && c.range) || (c.name === "set_selection" && c.moments?.length));

  function startEditing() {
    setDraft(initialDraft(calls));
    setEditError(null);
    setEditing(true);
  }

  function submitEdits(e: React.FormEvent) {
    e.preventDefault();
    const edits: { id: string; args: unknown }[] = [];
    for (const call of editable) {
      const value = draft[call.id];
      if (Array.isArray(value)) {
        if (value.length === 0) return setEditError(t("ask.approval.errorMoments"));
        edits.push({ id: call.id, args: { momentIds: value } });
      } else if (value) {
        const problem = checkClipEdit(value, call.name === "propose_clip");
        if (problem) return setEditError(t(`ask.approval.error.${problem}`));
        edits.push({ id: call.id, args: call.name === "propose_clip" ? { start: value.start, end: value.end, title: value.title.trim() } : { start: value.start, end: value.end } });
      }
    }
    setEditError(null);
    onDecide(action, { decision: "edit", edits });
  }

  const setClip = (id: string, patch: Partial<ClipDraft>) => setDraft((d) => ({ ...d, [id]: { ...(d[id] as ClipDraft), ...patch } }));
  const toggleMoment = (id: string, momentId: string, on: boolean) =>
    setDraft((d) => {
      const ids = (d[id] as string[]) ?? [];
      return { ...d, [id]: on ? [...ids, momentId] : ids.filter((m) => m !== momentId) };
    });

  const resolution = action.resolution as { decision?: string; stale?: StaleClip[] } | null;
  const decided =
    resolution?.stale && resolution.stale.length > 0
      ? staleLine(resolution.stale)
      : action.status === "dismissed" ? t("ask.approval.declined") : resolution?.decision === "edit" ? t("ask.approval.approvedEdited") : t("ask.approval.approved");

  return (
    <div role="group" aria-labelledby={headingId} className="grid gap-2 rounded-lg border border-border bg-stone-50 p-2">
      <p id={headingId} className="text-xs font-semibold">
        {calls.length === 1 ? t("ask.approval.titleOne") : t("ask.approval.title", { n: calls.length })}
      </p>
      {calls.length === 1 ? (
        <p lang={lang} dir="auto" className="break-words text-xs">
          {calls[0]!.summary}
        </p>
      ) : (
        // Numbered, so each block of the Edit form ("Change 2") points at its line.
        <ol className="grid list-decimal gap-1 pl-4 marker:text-muted-foreground">
          {calls.map((call) => (
            <li key={call.id} lang={lang} dir="auto" className="break-words text-xs">
              {call.summary}
            </li>
          ))}
        </ol>
      )}

      {action.status !== "pending" ? (
        <p className="text-xs text-muted-foreground">{decided}</p>
      ) : editing && !videoRemoved ? (
        <form onSubmit={submitEdits} className="grid gap-3" noValidate>
          {editable.map((call, index) => {
            const value = draft[call.id];
            // One white block per change, headed with its number in the list above, so fields never run together.
            const n = calls.indexOf(call) + 1;
            const head = calls.length > 1 && (
              <p className="text-xs font-semibold">
                {t("ask.approval.changeN", { n })}
              </p>
            );
            if (Array.isArray(value)) {
              return (
                <fieldset key={call.id} className={BLOCK}>
                  <legend className="sr-only">{calls.length > 1 ? `${t("ask.approval.changeN", { n })}: ${t("ask.approval.moments")}` : t("ask.approval.moments")}</legend>
                  {head}
                  <p aria-hidden className="text-xs font-medium">{t("ask.approval.moments")}</p>
                  {call.moments!.map((m) => (
                    <label key={m.id} className="flex items-start gap-2 text-xs">
                      <Checkbox autoFocus={index === 0 && m === call.moments![0]} checked={value.includes(m.id)} disabled={busy} onCheckedChange={(on) => toggleMoment(call.id, m.id, on === true)} className="mt-0.5" />
                      <span lang={lang} dir="auto" className="min-w-0 break-words">
                        <span dir="ltr" className="font-mono text-muted-foreground">{formatTimestamp(m.startMs)}</span> {m.title}
                      </span>
                    </label>
                  ))}
                </fieldset>
              );
            }
            if (!value) return null;
            const field = (key: "start" | "end") => (
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                {t(`ask.approval.${key}`)}
                <Input
                  // The form opens below the summary: focusing its first field brings it into view.
                  autoFocus={index === 0 && key === "start"}
                  value={value[key]}
                  disabled={busy}
                  inputMode="numeric"
                  placeholder="hh:mm:ss"
                  aria-invalid={editError !== null}
                  onChange={(e) => setClip(call.id, { [key]: e.target.value })}
                  className="h-8 bg-white font-mono text-xs"
                />
              </label>
            );
            return (
              <fieldset key={call.id} className={BLOCK}>
                <legend className="sr-only">{call.summary}</legend>
                {head}
                <div className="grid grid-cols-2 gap-2">
                  {field("start")}
                  {field("end")}
                </div>
                {call.name === "propose_clip" && (
                  <label className="grid gap-1 text-xs font-medium">
                    {t("ask.approval.clipTitle")}
                    <Input
                      value={value.title}
                      disabled={busy}
                      maxLength={120}
                      lang={lang}
                      dir="auto"
                      onChange={(e) => setClip(call.id, { title: e.target.value })}
                      className="h-8 bg-white text-xs"
                    />
                  </label>
                )}
              </fieldset>
            );
          })}
          {editHasClip(editable) && <p className="text-xs text-muted-foreground">{t("ask.approval.snapHint")}</p>}
          {editError && (
            <p role="alert" className="text-xs text-red-700">
              {editError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy} className="bg-brand text-white hover:brightness-90">
              <Busy busy={busy}>{busy ? t("ask.approval.sending") : t("ask.approval.approveEdited")}</Busy>
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              {t("ask.approval.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {!videoRemoved && (
            <Button type="button" size="sm" disabled={busy} onClick={() => onDecide(action, { decision: "approve" })} className="bg-brand text-white hover:brightness-90">
              <Busy busy={busy}>{busy ? t("ask.approval.sending") : t("ask.approval.approve")}</Busy>
            </Button>
          )}
          {!videoRemoved && editable.length > 0 && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={startEditing}>
              {t("ask.approval.edit")}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecide(action, { decision: "reject" })}>
            {t("ask.approval.reject")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
