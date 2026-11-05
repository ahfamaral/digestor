"use client";

import { useEffect, useState } from "react";
import { LANGUAGES, briefingToMarkdown, type BriefingContent, type MomentWithHighlights, type Topic } from "@digestor/core";
import { Dropdown } from "@/components/Dropdown";
import { Spinner } from "@/components/ui/spinner";
import type { BriefingTranslation } from "@/lib/useBriefingTranslation";
import { cn } from "@/lib/utils";
import { languageName, t } from "@/lib/i18n";

export const ACT =
  "inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";

function fileName(title: string, language: string | null): string {
  const slug = title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "briefing";
  return `${slug}${language ? `.${language}` : ""}.md`;
}

/**
 * The briefing document's actions: copy it as text, export it as .md, share the page link, and read it in another
 * language (with its translating / failed / machine-translation notes).
 */
export function DocActions({
  title,
  durationMs,
  language,
  briefing,
  topics,
  moments,
  tr,
}: {
  title: string;
  durationMs: number;
  language: string | null;
  briefing: BriefingContent | null;
  topics: Topic[];
  /** The analysis's own moments (the document never lists personal ones). */
  moments: MomentWithHighlights[];
  tr: BriefingTranslation;
}) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!notice?.ok) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const markdown = () => briefingToMarkdown({ title, durationMs, briefing, topics, moments, translation: tr.translated });

  async function copy(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ ok: true, text: ok });
    } catch {
      setNotice({ ok: false, text: t("preview.copyFailed") });
    }
  }

  function exportMarkdown() {
    const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName(title, tr.translated ? tr.readIn : null);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const offered = LANGUAGES.filter((l) => l.code !== language);
  return (
    <div>
      <div role="group" aria-label={t("preview.briefingActions")} className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={ACT} onClick={() => void copy(markdown(), t("preview.copied"))}>
          {t("preview.copyText")}
        </button>
        <button type="button" className={ACT} onClick={exportMarkdown}>
          {t("preview.export")}
        </button>
        <button type="button" className={ACT} title={t("preview.shareNote")} onClick={() => void copy(window.location.href, t("preview.linkCopied"))}>
          {t("preview.shareLink")}
        </button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {t("preview.readIn")}
          <Dropdown
            size="sm"
            value={tr.readIn}
            onValueChange={tr.pick}
            className="w-auto max-w-36"
            options={[
              { value: "", label: language ? t("preview.readInOriginal", { language: languageName(language) }) : t("preview.readInOriginalUnknown") },
              ...offered.map((l) => ({ value: l.code as string, label: l.label, lang: l.code as string })),
            ]}
          />
        </label>
      </div>
      <div aria-live="polite" className="min-h-0">
        {notice && (
          <p role={notice.ok ? "status" : "alert"} className={cn("mt-2 text-xs", notice.ok ? "text-emerald-700" : "text-red-700")}>
            {notice.text}
          </p>
        )}
        {tr.current?.status === "pending" && (
          <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner />
            {t("preview.translating")}
          </p>
        )}
        {tr.current?.status === "failed" && (
          <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-700">
            {tr.current.error}
            <button type="button" className={ACT} onClick={tr.retry}>
              {t("preview.retry")}
            </button>
          </p>
        )}
        {tr.translated && <p className="mt-2 text-xs text-muted-foreground">{t("preview.translationNote")}</p>}
      </div>
    </div>
  );
}
