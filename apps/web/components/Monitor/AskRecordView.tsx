import Link from "next/link";
import { MessageSquareQuote } from "lucide-react";
import { isWrittenOnly } from "@digestor/core";
import { CopyQuote } from "@/components/CopyQuote";
import { Spinner } from "@/components/ui/spinner";
import { questionTopic, type AskPassage, type AskResult } from "@/lib/monitor/askRecord";
import { formatSpeechTime, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { firstVideoRow } from "@/lib/monitor/video";
import { askHref, deputyHref, landingHref, MAX_QUERY, MONITOR_YEARS, type AskParams } from "@/lib/monitor/params";
import { quoteWithSource } from "@/lib/monitor/quote";
import { ExternalLink } from "./ExternalLink";
import { GetForm } from "./GetForm";
import { LanguageSwitch } from "./LanguageSwitch";
import { ReturnLink } from "./ReturnLink";
import { SpeechVideo } from "./SpeechVideo";

const card = "grid gap-3 rounded-xl border border-border bg-white p-4 sm:p-5";
const field = "h-9 w-full min-w-0 rounded-lg border border-input bg-white px-2 text-sm outline-none focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500";
const link = "w-fit rounded font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500";

/**
 * `/monitor/perguntar`, "Ask the record": a question, then passages quoted verbatim from the official speeches, each
 * with who said it (party and state on the day), when, the video moment and the way to the whole speech. Nothing on the
 * page is generated: the fixed line says so. `result: null` with `searching`: the Suspense fallback; `askedEmpty`: the
 * form was sent without a question. When the search by meaning is down, the word search is offered with the question.
 */
export function AskRecordView({
  locale, params, result, searching = false, askedEmpty = false,
}: { locale: MonitorLocale; params: AskParams; result: AskResult | null; searching?: boolean; askedEmpty?: boolean }) {
  const year = MONITOR_YEARS[0];
  // The word search gets what the question is about ("price of food"), not its framing.
  const words = landingHref({ q: params.q && questionTopic(params.q), from: params.from, to: params.to });
  return (
    <div lang={locale} className="grid gap-6">
      <div className="grid gap-1">
        <div>
          <ReturnLink href="/monitor" label={tm(locale, "member.back")} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-bold tracking-tight">{tm(locale, "ask.title")}</h1>
          <LanguageSwitch locale={locale} back={askHref(params)} />
        </div>
        <p className="text-sm text-muted-foreground">{tm(locale, "ask.fixedLine")}</p>
      </div>

      <section className={card} aria-label={tm(locale, "ask.title")}>
        <AskForm locale={locale} params={params} askedEmpty={askedEmpty} dates={{ min: `${year}-01-01`, max: `${year}-12-31` }} />
      </section>

      {searching && (
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {tm(locale, "ask.searching")}
        </p>
      )}
      {result && params.q && !result.ok && (
        <p role="status" className="text-sm">
          {tm(locale, "ask.unavailable")}{" "}
          <Link href={words} className={link}>{tm(locale, "ask.tryWords")}</Link>
        </p>
      )}
      {result?.ok && params.q && result.passages.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {tm(locale, "ask.none")}{" "}
          <Link href={words} className={`${link} text-foreground`}>{tm(locale, "ask.tryWords")}</Link>
        </p>
      )}
      {result?.ok && result.passages.length > 0 && (
        <section className="grid gap-2" aria-labelledby="ask-passages">
          <h2 id="ask-passages" className="sr-only">{tm(locale, "ask.passagesLabel")}</h2>
          <p className="text-xs text-muted-foreground">{tm(locale, "ask.perDeputy")}</p>
          <ul className="divide-y divide-border rounded-xl border border-border bg-white">
            {result.passages.map((p, i, all) => (
              <PassageItem key={p.speech.id} locale={locale} passage={p} videoNote={i === firstVideoRow(all.map((x) => x.speech))} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The question box; with `dates`, the speeches' date range too (the landing's third door has none). */
export function AskForm({
  locale, params, askedEmpty = false, dates, id = "ask-q",
}: { locale: MonitorLocale; params: AskParams; askedEmpty?: boolean; dates?: { min: string; max: string }; id?: string }) {
  return (
    <GetForm action="/monitor/perguntar" className="grid gap-3" required={{ name: "q", hint: tm(locale, "ask.noQuestion") }}>
      <label htmlFor={id} className={dates ? "text-sm font-medium" : "sr-only"}>{tm(locale, "ask.label")}</label>
      <div className="flex gap-2">
        <input
          id={id}
          name="q"
          type="search"
          defaultValue={params.q}
          maxLength={MAX_QUERY}
          placeholder={tm(locale, "ask.placeholder")}
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500 md:text-sm"
        />
        <button
          type="submit"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-stone-500"
        >
          <MessageSquareQuote className="size-4 group-aria-busy/get:hidden" aria-hidden />
          <Spinner className="size-4 hidden group-aria-busy/get:block" />
          {tm(locale, "ask.button")}
        </button>
      </div>
      {askedEmpty && <p role="status" className="-mt-1 text-sm text-muted-foreground">{tm(locale, "ask.noQuestion")}</p>}
      {dates && (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm text-muted-foreground">{tm(locale, "ask.dates")}</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{tm(locale, "filters.from")}</span>
              <input type="date" name="from" min={dates.min} max={dates.max} defaultValue={params.from ?? ""} className={field} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{tm(locale, "filters.to")}</span>
              <input type="date" name="to" min={dates.min} max={dates.max} defaultValue={params.to ?? ""} className={field} />
            </label>
          </div>
        </fieldset>
      )}
    </GetForm>
  );
}

/**
 * One quoted passage: the record's sentences, then who said them and when, the video moment, the whole speech and
 * "Copy quote with source" (the sentences with who, when, the official record and the video link).
 */
function PassageItem({ locale, passage, videoNote }: { locale: MonitorLocale; passage: AskPassage; videoNote: boolean }) {
  const { speech, sentences } = passage;
  const party = speech.partyThen ?? speech.member.party;
  const uf = speech.partyThen ? speech.ufThen : speech.member.uf;
  const day = speech.startsAt.slice(0, 10);
  const copy = quoteWithSource(locale, {
    quote: sentences.join(" "), name: speech.member.name, party, uf, startsAt: speech.startsAt, urlText: speech.urlText, video: speech.video,
  });
  return (
    <li className="grid gap-2 px-4 py-4 text-sm">
      <figure className="grid gap-2">
        <blockquote lang="pt-BR" className="border-l-2 border-stone-300 pl-3 text-[0.9375rem] leading-relaxed break-words">
          {sentences.join(" ")}
        </blockquote>
        <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span>
            <Link href={deputyHref(speech.member.externalId)} className="font-semibold underline-offset-2 hover:underline">
              {speech.member.name}
            </Link>
            {party && <span className="text-muted-foreground"> · {[party, uf].filter(Boolean).join("-")}</span>}
          </span>
          <time dateTime={speech.startsAt} className="font-mono text-xs text-muted-foreground">
            {formatSpeechTime(speech.startsAt, locale)}
          </time>
          {speech.phase && <span className="text-xs text-muted-foreground">{speech.phase}</span>}
        </figcaption>
      </figure>
      {speech.video ? (
        <SpeechVideo locale={locale} video={speech.video} label="at" note={videoNote} />
      ) : (
        speech.text && isWrittenOnly(speech.text) && <p className="text-xs text-muted-foreground">{tm(locale, "speech.writtenOnly")}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <Link href={`${deputyHref(speech.member.externalId, { from: day, to: day })}#speeches`} className={link}>
          {tm(locale, "ask.readSpeech")}
        </Link>
        {speech.urlText && <ExternalLink href={speech.urlText} className="font-medium underline">{tm(locale, "member.officialRecord")}</ExternalLink>}
        <CopyQuote
          text={copy} label={tm(locale, "copyQuote.button")} copiedLabel={tm(locale, "copyQuote.copied")} failedLabel={tm(locale, "copyQuote.failed")}
          className="h-7 border-border bg-white px-2.5 text-xs"
        />
      </div>
    </li>
  );
}
