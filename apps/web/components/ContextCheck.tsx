"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES, PROFILES, type ContextCard, type ProfileId, type Fact } from "@digestor/core";
import { buildContextPayload, type ContextFields } from "@/lib/contextPayload";
import { cn } from "@/lib/utils";

const BADGES = {
  video: { text: "from video", cls: "bg-green-100 text-green-800" },
  metadata: { text: "from metadata", cls: "bg-stone-200 text-stone-700" },
  human: { text: "from you", cls: "bg-purple-100 text-purple-800" },
  missing: { text: "missing", cls: "bg-red-100 text-red-700" },
} as const;

function Badge({ kind, audio }: { kind: keyof typeof BADGES; audio?: boolean }) {
  const b = audio && kind === "video" ? { ...BADGES.video, text: "from audio" } : BADGES[kind];
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", b.cls)}>{b.text}</span>;
}

/** Source of a displayed value: edited → "from you"; empty → missing; else the fact's own source. */
function kindOf(fact: Fact | null, value: string, original: string): keyof typeof BADGES {
  if (value.trim() !== original.trim()) return value.trim() ? "human" : "missing";
  if (!value.trim()) return "missing";
  return fact?.source ?? "human";
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
export function ContextCheck({ sessionId, card }: { sessionId: string; card: ContextCard }) {
  const router = useRouter();
  const [original] = useState(() => toFields(card));
  const [edited, setEdited] = useState<ContextFields>(original);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  const set = <K extends keyof ContextFields>(key: K, value: ContextFields[K]) => setEdited((e) => ({ ...e, [key]: value }));
  const setPerson = (i: number, key: "name" | "role" | "affiliation", value: string) =>
    setEdited((e) => ({ ...e, participants: e.participants.map((p, j) => (j === i ? { ...p, [key]: value } : p)) }));

  function hear(startMs: number) {
    const v = player.current;
    if (!v) return;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    v.currentTime = startMs / 1000;
    void v.play().catch(() => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      setError("Could not play the sample.");
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
        throw new Error(data.error ?? "Something went wrong. Try again.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const onContinue = () =>
    submit(buildContextPayload(original, edited, card.openQuestions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" }))));
  const onSkip = () => submit({ action: "skip" });

  const n = card.openQuestions.length;
  const textRow = (label: string, key: "title" | "setting" | "dateOrYear", fact: Fact) => (
    <Row label={label} badge={kindOf(fact, edited[key], original[key])}>
      <input
        className={inputCls}
        aria-label={label}
        value={edited[key]}
        placeholder="not found"
        onChange={(e) => set(key, e.target.value)}
        onBlur={() => !edited[key].trim() && set(key, original[key])}
      />
    </Row>
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-xl border border-border bg-white p-5">
        <h2 className="mb-2 text-base font-bold">Here&apos;s what I understood</h2>
        <Row
          label="Language"
          audio
          badge={edited.language !== original.language ? "human" : card.language.value ? (card.language.source ?? "video") : "missing"}
        >
          <select
            className={inputCls}
            aria-label="Language"
            value={edited.language}
            onChange={(e) => set("language", e.target.value)}
          >
            {!edited.language && <option value="">Unknown</option>}
            {!LANGUAGES.some((l) => l.code === original.language) && original.language && (
              <option value={original.language}>{original.language} (detected)</option>
            )}
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Event type" badge={edited.profile !== original.profile ? "human" : "video"}>
          <select
            className={inputCls}
            aria-label="Event type"
            value={edited.profile}
            onChange={(e) => set("profile", e.target.value as ProfileId)}
          >
            {(Object.keys(PROFILES) as ProfileId[]).map((t) => (
              <option key={t} value={t}>
                {PROFILES[t].label}
              </option>
            ))}
          </select>
        </Row>
        {textRow("Title / topic", "title", card.title)}
        {textRow("Setting", "setting", card.setting)}
        {textRow("Date", "dateOrYear", card.dateOrYear)}
        {card.participants.map((p, i) => {
          const o = original.participants[i];
          const e = edited.participants[i];
          return (
            <div key={p.speakerId} className="border-b border-border py-2 last:border-b-0">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">Speaker {p.speakerId}</div>
              {(["name", "role", "affiliation"] as const).map((k) => (
                <div key={k} className="mb-1 flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{k[0].toUpperCase() + k.slice(1)}</span>
                  <input
                    className={inputCls}
                    aria-label={`Speaker ${p.speakerId} ${k}`}
                    value={e[k]}
                    placeholder="not found"
                    onChange={(ev) => setPerson(i, k, ev.target.value)}
                    onBlur={() => !e[k].trim() && setPerson(i, k, o[k])}
                  />
                  <Badge kind={kindOf(p[k], e[k], o[k])} />
                </div>
              ))}
            </div>
          );
        })}
      </section>

      <section className="flex flex-col rounded-xl border-2 border-purple-400 bg-white p-5">
        <h2 className="mb-2 text-base font-bold">
          {n === 0 ? "No questions" : `${n} quick question${n === 1 ? "" : "s"}`}
        </h2>
        {n === 0 && <p className="text-sm text-muted-foreground">Everything looks clear. Check the card and continue.</p>}
        {card.openQuestions.map((q) => (
          <div key={q.id} className="mb-3 border-b border-border pb-3 last:border-b-0">
            <div className="text-sm font-semibold">{q.question}</div>
            <div className="mb-2 text-xs text-muted-foreground">Why: {q.why}</div>
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
                  ▶ hear 5 s
                </button>
              )}
            </div>
          </div>
        ))}
        <video ref={player} src={`/api/files/${sessionId}/proxy.mp4`} preload="none" className="hidden" />

        {error && (
          <p role="alert" className="mb-2 rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            disabled={busy}
            onClick={onContinue}
            className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            Continue →
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSkip}
            className="text-sm font-medium text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Skip — find clips anyway
          </button>
        </div>
      </section>
    </div>
  );
}
