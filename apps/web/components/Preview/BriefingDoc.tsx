"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LANGUAGES, briefingToMarkdown, formatLength, formatMinutes, formatTimestamp, type BriefingContent, type MomentWithHighlights,
  type Topic,
} from "@digestor/core";
import { HighlightChip } from "@/components/HighlightChip";
import { translationFromResponse, type Translation } from "@/lib/briefingTranslation";
import { errorMessage } from "@/lib/http";
import type { PreviewSection } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { languageName, t } from "@/lib/i18n";

const POLL_MS = 3000;
const ACT =
  "inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";

function fileName(title: string, language: string | null): string {
  const slug = title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "briefing";
  return `${slug}${language ? `.${language}` : ""}.md`;
}

const sentences = (s: { text: string }[]) => s.map((x) => x.text).join(" ").trim();

/**
 * The briefing as a sober document: lead, then one section per topic with its summary, key quote and highlight
 * rows (▶ Play on the proxy, + Clip to Prepare). Actions: copy as text, export as .md, share the link, read in
 * another language (created on first request, polled until ready).
 */
export function BriefingDoc({
  sessionId,
  analysisId,
  title,
  durationMs,
  language,
  hasVideo,
  videoRemoved,
  briefing,
  topics,
  moments,
  sections,
  activeTopicId,
  flashMomentId,
  sectionRef,
}: {
  sessionId: string;
  analysisId: string;
  title: string;
  durationMs: number;
  language: string | null;
  hasVideo: boolean;
  videoRemoved: boolean;
  briefing: BriefingContent | null;
  topics: Topic[];
  moments: MomentWithHighlights[];
  sections: PreviewSection[];
  activeTopicId: string | null;
  flashMomentId: string | null;
  sectionRef: (topicId: string, el: HTMLElement | null) => void;
}) {
  const router = useRouter();
  const lang = language ?? undefined;
  const [readIn, setReadIn] = useState("");
  const [translations, setTranslations] = useState<Record<string, Translation>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [clipping, setClipping] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const current = readIn ? translations[readIn] : undefined;
  const translated = current?.status === "ready" ? current.content : null;
  const trLang = translated ? readIn : undefined;

  // Poll a pending translation every 3 s while it is the one being read.
  useEffect(() => {
    if (!readIn || current?.status !== "pending") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let next: Translation;
      try {
        const res = await fetch(`/api/analyses/${analysisId}/translations?language=${encodeURIComponent(readIn)}`);
        next = translationFromResponse("poll", res.status, await res.json().catch(() => null));
      } catch {
        next = { status: "pending" }; // network blip: keep polling
      }
      if (!cancelled) setTranslations((all) => ({ ...all, [readIn]: next }));
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readIn, current, analysisId]);

  useEffect(() => {
    if (!notice?.ok) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function requestTranslation(code: string) {
    setTranslations((all) => ({ ...all, [code]: { status: "pending" } }));
    let next: Translation;
    try {
      const res = await fetch(`/api/analyses/${analysisId}/translations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      next = translationFromResponse("request", res.status, await res.json().catch(() => null));
    } catch {
      next = { status: "failed", error: t("preview.translationFailed") };
    }
    setTranslations((all) => ({ ...all, [code]: next }));
  }

  function pickLanguage(code: string) {
    setReadIn(code);
    if (code && translations[code]?.status !== "ready" && translations[code]?.status !== "pending") void requestTranslation(code);
  }

  const markdown = () => briefingToMarkdown({ title, durationMs, briefing, topics, moments, translation: translated });

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
    a.download = fileName(title, translated ? readIn : null);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function addClip(m: MomentWithHighlights) {
    setClipping(m.id);
    setRowError(null);
    try {
      const sel = await fetch(`/api/moments/${m.id}/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!sel.ok) throw new Error(await errorMessage(sel, t("preview.errorGeneric")));
      const res = await fetch(`/api/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds: [m.id] }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, t("preview.errorGeneric")));
      router.push(`/s/${sessionId}/prepare`);
      setClipping(null); // if navigation stalls, the rows stay usable (the clip exists; repeating is safe)
    } catch (err) {
      setClipping(null);
      setRowError({ id: m.id, text: err instanceof Error && err.message ? err.message : t("preview.errorGeneric") });
    }
  }

  const lead = briefing ? sentences(briefing.lead) : "";
  const leadTr = translated ? sentences(translated.lead) : "";
  const offered = LANGUAGES.filter((l) => l.code !== language);

  return (
    <article aria-labelledby="briefing-heading" className="rounded-xl border border-border bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="briefing-heading" className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {t("preview.briefing")}
        </h2>
        <div role="group" aria-label={t("preview.briefingActions")} className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={ACT} onClick={() => void copy(markdown(), t("preview.copied"))}>
            {t("preview.copyText")}
          </button>
          <button type="button" className={ACT} onClick={exportMarkdown}>
            {t("preview.export")}
          </button>
          <button
            type="button"
            className={ACT}
            title={t("preview.shareNote")}
            onClick={() => void copy(window.location.href, t("preview.linkCopied"))}
          >
            {t("preview.shareLink")}
          </button>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {t("preview.readIn")}
            <select value={readIn} onChange={(e) => pickLanguage(e.target.value)} className={cn(ACT, "max-w-36 pr-1")}>
              <option value="">{language ? t("preview.readInOriginal", { language: languageName(language) }) : t("preview.readInOriginalUnknown")}</option>
              {offered.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div aria-live="polite" className="min-h-0">
        {notice && (
          <p role={notice.ok ? "status" : "alert"} className={cn("mt-2 text-xs", notice.ok ? "text-emerald-700" : "text-red-700")}>
            {notice.text}
          </p>
        )}
        {current?.status === "pending" && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t("preview.translating")}
          </p>
        )}
        {current?.status === "failed" && (
          <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-700">
            {current.error}
            <button type="button" className={ACT} onClick={() => void requestTranslation(readIn)}>
              {t("preview.retry")}
            </button>
          </p>
        )}
        {translated && <p className="mt-2 text-xs text-muted-foreground">{t("preview.translationNote")}</p>}
      </div>

      {lead && (
        <p lang={leadTr ? trLang : lang} dir="auto" className="mt-3 text-[15px] leading-relaxed">
          {leadTr || lead}
        </p>
      )}
      {!briefing && <p className="mt-3 text-sm text-muted-foreground">{t("preview.noBriefing")}</p>}

      {sections.map((s) => {
        const trSection = translated?.sections.find((x) => x.topicId === s.topic.id);
        const summaryTr = s.fromBriefing && trSection ? sentences(trSection.summary) : "";
        const quoteTr = trSection?.keyQuote && trSection.keyQuote.momentId === s.keyQuote?.momentId ? trSection.keyQuote.translation : "";
        return (
          <section
            key={s.topic.id}
            id={`topic-${s.topic.id}`}
            data-topic-id={s.topic.id}
            ref={(el) => sectionRef(s.topic.id, el)}
            aria-labelledby={`topic-h-${s.topic.id}`}
            className="scroll-mt-3 sm:scroll-mt-32 border-t border-[#f0ede6] pt-3 mt-4"
          >
            <h3
              id={`topic-h-${s.topic.id}`}
              className={cn(
                "-mx-2 flex flex-wrap items-baseline gap-x-2.5 rounded-md px-2 py-1 text-[15px] font-bold",
                s.topic.id === activeTopicId && "bg-background",
              )}
            >
              <span lang={lang} dir="auto">
                {s.n} · {s.topic.title}
              </span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {formatTimestamp(s.topic.startMs)} · {formatMinutes(s.topic.endMs - s.topic.startMs)}
              </span>
            </h3>
            {s.summary && (
              <p lang={summaryTr ? trLang : lang} dir="auto" className={cn("mt-1 text-sm leading-relaxed", !s.fromBriefing && "text-muted-foreground")}>
                {summaryTr || s.summary}
              </p>
            )}
            {s.keyQuote && (
              <blockquote className="my-2.5 border-l-[3px] border-stone-400 bg-stone-50 px-3 py-1.5 text-sm">
                <p lang={lang} dir="auto" className="italic">
                  “{s.keyQuote.text}”
                  {s.keyQuote.startMs !== null && (
                    <span className="ml-1.5 font-mono text-xs not-italic text-muted-foreground">— {formatTimestamp(s.keyQuote.startMs)}</span>
                  )}
                </p>
                {quoteTr && (
                  <p lang={trLang} dir="auto" className="mt-1 text-muted-foreground">
                    “{quoteTr}”
                  </p>
                )}
              </blockquote>
            )}
            {s.rows.length > 0 && (
              <ul className="mt-2 space-y-2.5">
                {s.rows.map((m) => (
                  <HighlightRow
                    key={m.id}
                    moment={m}
                    sessionId={sessionId}
                    language={lang}
                    hasVideo={hasVideo}
                    videoRemoved={videoRemoved}
                    playing={playing === m.id}
                    onPlay={() => setPlaying((p) => (p === m.id ? null : m.id))}
                    clipping={clipping === m.id}
                    clipDisabled={clipping !== null}
                    onClip={() => void addClip(m)}
                    error={rowError?.id === m.id ? rowError.text : null}
                    flash={flashMomentId === m.id}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </article>
  );
}

function HighlightRow({
  moment: m,
  sessionId,
  language,
  hasVideo,
  videoRemoved,
  playing,
  onPlay,
  clipping,
  clipDisabled,
  onClip,
  error,
  flash,
}: {
  moment: MomentWithHighlights;
  sessionId: string;
  language: string | undefined;
  hasVideo: boolean;
  videoRemoved: boolean;
  playing: boolean;
  onPlay: () => void;
  clipping: boolean;
  clipDisabled: boolean;
  onClip: () => void;
  error: string | null;
  flash: boolean;
}) {
  const types = [...new Map(m.highlights.map((h) => [h.type, h])).values()];
  // #t= takes seconds; the proxy route answers Range requests, so only the fragment's bytes load.
  const src = `/api/files/${sessionId}/proxy.mp4#t=${(m.startMs / 1000).toFixed(1)},${(m.endMs / 1000).toFixed(1)}`;
  const playerLabel = t("preview.playerLabel", { title: m.title });
  return (
    <li id={`moment-${m.id}`} className={cn("scroll-mt-24 sm:scroll-mt-36 rounded-lg transition-colors duration-700 motion-reduce:transition-none", flash && "bg-amber-50")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {types.map((h) => (
          <HighlightChip key={h.type} type={h.type} method={h.method} />
        ))}
        <span lang={language} dir="auto" className="min-w-0 text-sm font-medium">
          {m.title}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {formatTimestamp(m.startMs)} · {formatLength(m.endMs - m.startMs)}
        </span>
        <span className="flex gap-1.5">
          <button
            type="button"
            className={ACT}
            onClick={onPlay}
            disabled={videoRemoved}
            aria-expanded={playing}
            aria-label={playing ? t("preview.stopLabel", { title: m.title }) : t("preview.playLabel", { title: m.title })}
            aria-describedby={videoRemoved ? "video-removed" : undefined}
          >
            {playing ? t("preview.stop") : t("preview.play")}
          </button>
          <button
            type="button"
            className={ACT}
            onClick={onClip}
            disabled={videoRemoved || clipDisabled}
            aria-label={t("preview.clipLabel", { title: m.title })}
            aria-describedby={videoRemoved ? "video-removed" : undefined}
          >
            {clipping ? t("preview.clipBusy") : t("preview.clip")}
          </button>
        </span>
      </div>
      {m.why && <p className="mt-0.5 text-xs text-muted-foreground">{t("preview.why", { why: m.why })}</p>}
      {playing && !videoRemoved && (
        <div className="mt-2">
          {hasVideo ? (
            <video controls autoPlay preload="none" src={src} aria-label={playerLabel} className="aspect-video w-full max-w-xl rounded-lg bg-black" />
          ) : (
            <audio controls autoPlay preload="none" src={src} aria-label={playerLabel} className="w-full max-w-xl" />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </li>
  );
}
