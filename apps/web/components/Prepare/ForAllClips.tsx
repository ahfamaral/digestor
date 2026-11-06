"use client";

import { useState } from "react";
import { LANGUAGES, type ClipFormat } from "@digestor/core";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { applyToAll, languageTargets, sharedValue, subtitleLanguages, type SharedKey } from "@/lib/prepareData";
import { languageName, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface ForAllClip {
  id: string;
  credit: string | null;
  format: ClipFormat;
  noCreditNeeded: boolean;
  languages: string[];
  /** The video was removed (R30): the clip can't change any more. */
  frozen: boolean;
}

/** What the strip asks of the list: set one value on these clips, in sequence; resolves how many failed. */
export type ForAllRun =
  | { kind: "credit"; value: string; ids: string[] }
  | { kind: "format"; value: ClipFormat; ids: string[] }
  | { kind: "language"; value: string; ids: string[] };

export interface ForAllClipsProps {
  clips: ForAllClip[];
  originalLanguage: string | null;
  /** Saves the change clip by clip (a failure is shown on that clip's card and the rest go on); resolves the failed ids. */
  onRun: (run: ForAllRun, progress: (done: number) => void) => Promise<string[]>;
}

const FIELD =
  "h-8 min-w-0 rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand";
const ACT =
  "inline-flex h-8 items-center rounded-md border border-border bg-white px-3 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground";

/** "For all clips": credit line, format and an extra subtitle language, applied to the clips still on the shared value. */
export function ForAllClips({ clips, originalLanguage, onRun }: ForAllClipsProps) {
  const credit = sharedValue(clips, "credit");
  const format = sharedValue(clips, "format");
  const [creditDraft, setCreditDraft] = useState<string | null>(null);
  const [lang, setLang] = useState("");
  const [pending, setPending] = useState<ForAllRun | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [summary, setSummary] = useState("");

  const creditValue = creditDraft ?? credit.value ?? "";
  const all = clips.length;
  const options = subtitleLanguages(originalLanguage, []).filter((o) => languageTargets(clips, o.code).length > 0);
  const chosen = options.some((o) => o.code === lang) ? lang : (options[0]?.code ?? "");

  const label = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? languageName(code);

  function ask(key: SharedKey | "language", value: string) {
    setSummary("");
    if (key === "language") return setPending({ kind: "language", value, ids: languageTargets(clips, value) });
    const shared = key === "credit" ? credit : format;
    const ids = applyToAll(clips, key, shared.value, key === "credit" ? value.trim() : value);
    if (ids.length === 0) return setSummary(t("prepare.allNothing"));
    setPending(key === "credit" ? { kind: "credit", value: value.trim(), ids } : { kind: "format", value: value as ClipFormat, ids });
  }

  async function confirm() {
    if (!pending) return;
    setProgress(0);
    const failed = await onRun(pending, setProgress);
    const n = pending.ids.length;
    setSummary(
      failed.length === 0
        ? n === 1 ? t("prepare.allDoneOne") : t("prepare.allDone", { n })
        : t("prepare.allPartial", { ok: n - failed.length, n, bad: failed.length }),
    );
    if (pending.kind === "credit") setCreditDraft(null);
  }

  const n = pending?.ids.length ?? 0;
  const kept = all - n;
  const keptText = (m: number, one: "prepare.allKeptOne" | "prepare.allConfirmLanguageKeptOne", many: "prepare.allKept" | "prepare.allConfirmLanguageKept") =>
    m === 0 ? "" : m === 1 ? t(one) : t(many, { m });
  const what = !pending
    ? ""
    : pending.kind === "credit"
      ? pending.value === "" ? t("prepare.allConfirmCreditEmpty") : t("prepare.allConfirmCredit", { value: pending.value })
      : pending.kind === "format"
        ? t("prepare.allConfirmFormat", { value: pending.value })
        : t("prepare.allConfirmLanguage", { value: label(pending.value) });
  const description = progress !== null
    ? t("prepare.allApplying", { i: Math.min(progress + 1, n), n })
    : `${what}${pending?.kind === "language" ? keptText(kept, "prepare.allConfirmLanguageKeptOne", "prepare.allConfirmLanguageKept") : keptText(kept, "prepare.allKeptOne", "prepare.allKept")}`;

  return (
    <section aria-labelledby="for-all-h" className="mb-4 rounded-xl border border-border bg-white p-3 sm:p-4">
      <h2 id="for-all-h" className="text-[15px] font-bold">{t("prepare.allTitle")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("prepare.allHelp")}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <label htmlFor="all-credit" className="mb-1.5 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("prepare.allCredit")}
          </label>
          <div className="flex gap-2">
            <input
              id="all-credit"
              value={creditValue}
              maxLength={200}
              placeholder={t("prepare.creditPlaceholder")}
              onChange={(e) => setCreditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (creditValue.trim() !== (credit.value ?? "")) ask("credit", creditValue);
                }
              }}
              className={cn(FIELD, "flex-1")}
            />
            <button
              type="button"
              aria-label={t("prepare.allApplyLabel")}
              disabled={creditValue.trim() === (credit.value ?? "")}
              onClick={() => ask("credit", creditValue)}
              className={ACT}
            >
              {t("prepare.allApply")}
            </button>
          </div>
        </div>
        <div>
          <h3 id="all-format-h" className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("prepare.allFormat")}</h3>
          <div role="group" aria-labelledby="all-format-h" className="inline-flex rounded-lg border border-border bg-white p-0.5">
            {(["16:9", "9:16"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format.value === f && format.differs.length === 0}
                onClick={() => ask("format", f)}
                className={cn(
                  "inline-flex h-8 min-w-12 items-center justify-center rounded-md px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  format.value === f && format.differs.length === 0 ? "bg-foreground text-white" : "text-foreground hover:bg-muted",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="all-language" className="mb-1.5 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("prepare.allLanguage")}
          </label>
          <div className="flex gap-2">
            <select id="all-language" value={chosen} disabled={options.length === 0} onChange={(e) => setLang(e.target.value)} className={cn(FIELD, "flex-1")}>
              {options.map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
            <button type="button" aria-label={t("prepare.allAddLabel")} disabled={!chosen} onClick={() => ask("language", chosen)} className={ACT}>
              {t("prepare.add")}
            </button>
          </div>
        </div>
      </div>
      <p role="status" className="mt-2 min-h-4 text-xs text-muted-foreground">{summary}</p>
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setPending(null);
              setProgress(null);
            }
          }}
          title={n === 1 ? t("prepare.allConfirmTitleOne") : t("prepare.allConfirmTitle", { n })}
          description={description}
          actionLabel={t("prepare.allAction")}
          busyLabel={t(pending.kind === "credit" ? "prepare.allBusyCredit" : pending.kind === "format" ? "prepare.allBusyFormat" : "prepare.adding")}
          onConfirm={confirm}
        />
      )}
    </section>
  );
}
