"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES, PROFILES, type ContextCard, type ProfileId, type Fact } from "@digestor/core";
import { RecordLink } from "@/components/Names/RecordLink";
import { WhosWho } from "@/components/Names/WhosWho";
import type { NamesData, WhosWhoRow } from "@/lib/names";
import { labelText, splitSpeakerQuestions, voiceLabel } from "@/lib/names";
import { factBadge, profileBadge } from "@/lib/contextBadge";
import { buildContextPayload, buildSkipPayload, type ContextFields } from "@/lib/contextPayload";
import { sampleSrc } from "@/lib/media";
import { usePauseWhenHidden } from "@/lib/usePauseWhenHidden";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";
import { Dropdown } from "@/components/Dropdown";

const BADGES = {
  video: { text: "context.badgeVideo", cls: "bg-green-100 text-green-800" },
  metadata: { text: "context.badgeMetadata", cls: "bg-stone-200 text-stone-700" },
  ai: { text: "context.badgeSuggested", cls: "bg-stone-100 text-stone-600" },
  human: { text: "context.badgeHuman", cls: "bg-purple-100 text-purple-800" },
  missing: { text: "context.badgeMissing", cls: "bg-red-100 text-red-700" },
} as const satisfies Record<string, { text: MessageKey; cls: string }>;

const FIELD_LABEL = {
  role: "context.fieldRole",
  affiliation: "context.fieldAffiliation",
} as const satisfies Record<string, MessageKey>;
const FIELD_ARIA = {
  role: "context.speakerRole",
  affiliation: "context.speakerAffiliation",
} as const satisfies Record<string, MessageKey>;

function Badge({ kind, audio }: { kind: keyof typeof BADGES; audio?: boolean }) {
  const b = audio && kind === "video" ? { ...BADGES.video, text: "context.badgeAudio" as const } : BADGES[kind];
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", b.cls)}>{t(b.text)}</span>;
}

function toFields(card: ContextCard): ContextFields {
  return {
    profile: card.profile.value,
    language: card.language.value ?? "",
    title: card.title.value ?? "",
    setting: card.setting.value ?? "",
    dateOrYear: card.dateOrYear.value ?? "",
    participants: card.participants.map((p) => ({
      speakerId: p.speakerId,
      name: p.name.value ?? "",
      role: p.role.value ?? "",
      affiliation: p.affiliation.value ?? "",
    })),
  };
}

const inputCls = "h-8 min-w-0 flex-1 rounded-md border border-border bg-white px-2 text-sm outline-none focus:border-brand";

function Row({ label, badge, audio, children }: { label: string; badge: keyof typeof BADGES; audio?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border py-2 last:border-b-0">
      <span className="w-24 shrink-0 text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
      <Badge kind={badge} audio={audio} />
    </div>
  );
}

/** Context check screen: review what the agent understood, answer its questions, then continue or skip. */
export function ContextCheck({
  sessionId, card, names, rows, proxyReady,
}: { sessionId: string; card: ContextCard; names: NamesData; rows: WhosWhoRow[]; /** The 480p preview copy exists; until then the samples play from the audio. */ proxyReady: boolean }) {
  const router = useRouter();
  const [original] = useState(() => toFields(card));
  const [edited, setEdited] = useState<ContextFields>(original);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  usePauseWhenHidden(player);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  const set = <K extends keyof ContextFields>(key: K, value: ContextFields[K]) => setEdited((e) => ({ ...e, [key]: value }));
  const setPerson = (i: number, key: "role" | "affiliation", value: string) =>
    setEdited((e) => ({ ...e, participants: e.participants.map((p, j) => (j === i ? { ...p, [key]: value } : p)) }));

  function hear(startMs: number) {
    const v = player.current;
    if (!v) return;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    v.currentTime = startMs / 1000;
    void v.play().catch(() => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      setError(t("context.couldNotPlay"));
    });
    stopTimer.current = setTimeout(() => v.pause(), 5000);
  }

  async function submit(body: unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t("context.errorGeneric"));
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("context.errorGeneric"));
      setBusy(false);
    }
  }

  const onContinue = () =>
    submit(buildContextPayload(original, edited, card.openQuestions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" }))));
  const onSkip = () => submit(buildSkipPayload(original, edited));

  // "Who is speaker B?" is answered in B's Who's who row (above Continue); the other questions stay in their card.
  const { inline, rest } = splitSpeakerQuestions(card.openQuestions, rows.map((r) => r.speakerId));
  const speakerQuestions = Object.fromEntries(inline.map((q) => [q.speakerId as string, { id: q.id, question: q.question, why: q.why }]));
  const n = rest.length;
  const showQuestions = card.openQuestions.length === 0 || rest.length > 0;
  const textRow = (label: string, key: "title" | "setting" | "dateOrYear", fact: Fact) => (
    <Row label={label} badge={factBadge(fact, edited[key], original[key])}>
      <input
        className={inputCls}
        aria-label={label}
        value={edited[key]}
        placeholder={t("context.notFound")}
        onChange={(e) => set(key, e.target.value)}
        onBlur={() => !edited[key].trim() && set(key, original[key])}
      />
    </Row>
  );

  return (
    <div className="flex flex-col gap-4">
    <RecordLink sessionId={sessionId} profile={edited.profile} suggestionOnly />
    <div className={cn("grid grid-cols-1 gap-4", showQuestions && "md:grid-cols-2")}>
      <section className="rounded-xl border border-border bg-white p-5">
        <h2 className="mb-2 text-base font-bold">{t("context.understood")}</h2>
        <Row
          label={t("context.language")}
          audio
          badge={edited.language !== original.language ? "human" : card.language.value ? (card.language.source ?? "video") : "missing"}
        >
          <Dropdown
            className="flex-1"
            aria-label={t("context.language")}
            value={edited.language}
            onValueChange={(v) => set("language", v)}
            options={[
              ...(!edited.language ? [{ value: "", label: t("context.languageUnknown") }] : []),
              ...(!LANGUAGES.some((l) => l.code === original.language) && original.language
                ? [{ value: original.language, label: t("context.languageDetected", { code: original.language }) }]
                : []),
              ...LANGUAGES.map((l) => ({ value: l.code as string, label: l.label, lang: l.code as string })),
            ]}
          />
        </Row>
        <Row label={t("context.profile")} badge={profileBadge(edited.profile, original.profile)}>
          <Dropdown
            className="flex-1"
            aria-label={t("context.profile")}
            value={edited.profile}
            onValueChange={(v) => set("profile", v)}
            options={(Object.keys(PROFILES) as ProfileId[]).map((id) => ({ value: id, label: t(`profile.${id}`) }))}
          />
        </Row>
        {textRow(t("context.titleTopic"), "title", card.title)}
        {textRow(t("context.setting"), "setting", card.setting)}
        {textRow(t("context.date"), "dateOrYear", card.dateOrYear)}
        {card.participants.map((p, i) => {
          const o = original.participants[i];
          const e = edited.participants[i];
          return (
            <div key={p.speakerId} className="border-b border-border py-2 last:border-b-0">
              <div dir="auto" className="mb-1 text-xs font-semibold text-muted-foreground">{labelText(voiceLabel(names, p.speakerId, 0, PROFILES[edited.profile].sensitive))}</div>
              {(["role", "affiliation"] as const).map((k) => (
                <div key={k} className="mb-1 flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{t(FIELD_LABEL[k])}</span>
                  <input
                    className={inputCls}
                    aria-label={t(FIELD_ARIA[k], { id: p.speakerId })}
                    value={e[k]}
                    placeholder={t("context.notFound")}
                    onChange={(ev) => setPerson(i, k, ev.target.value)}
                    onBlur={() => !e[k].trim() && setPerson(i, k, o[k])}
                  />
                  <Badge kind={factBadge(p[k], e[k], o[k])} />
                </div>
              ))}
            </div>
          );
        })}
      </section>

      {showQuestions && (
      <section className="flex flex-col rounded-xl border-2 border-purple-400 bg-white p-5">
        <h2 className="mb-2 text-base font-bold">
          {n === 0 ? t("context.noQuestions") : n === 1 ? t("context.questionsOne") : t("context.questionsMany", { n })}
        </h2>
        {n === 0 && <p className="text-sm text-muted-foreground">{t("context.allClear")}</p>}
        {rest.map((q) => (
          <div key={q.id} className="mb-3 border-b border-border pb-3 last:border-b-0">
            <div className="text-sm font-semibold">{q.question}</div>
            <div className="mb-2 text-xs text-muted-foreground">{t("context.why", { why: q.why })}</div>
            <div className="flex items-center gap-2">
              <input
                className={inputCls}
                aria-label={q.question}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
              {q.sampleStartMs !== null && (
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted"
                  onClick={() => hear(q.sampleStartMs as number)}
                >
                  {t("context.hear")}
                </button>
              )}
            </div>
          </div>
        ))}
      </section>
      )}
    </div>
      <section aria-labelledby="whos-who-title" className="rounded-xl border border-border bg-white p-5">
        <h2 id="whos-who-title" className="mb-1 text-base font-bold">{t("names.whoTitle")}</h2>
        <p className="mb-2 text-xs text-muted-foreground">{t("names.whoHint")}</p>
        <WhosWho sessionId={sessionId} rows={rows} names={names} sensitive={PROFILES[edited.profile].sensitive} language={edited.language || undefined} profile={edited.profile} mode="context" proxyReady={proxyReady} speakerQuestions={speakerQuestions} answers={answers} onAnswer={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))} />
      </section>
      <video ref={player} src={sampleSrc(sessionId, proxyReady)} preload="none" className="hidden" />
      {error && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-disabled disabled:text-disabled-foreground"
        >
          {t("context.continue")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="text-sm font-medium text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t("context.skip")}
        </button>
      </div>
    </div>
  );
}
