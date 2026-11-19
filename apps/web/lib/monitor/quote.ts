// Client-safe: the text "Copy quote with source" puts on the clipboard (built on the server, passed to the button).

import { HIGHLIGHT_END, HIGHLIGHT_START } from "@digestor/core";
import { formatSpeechTime, tm, type MonitorLocale } from "./i18n";
import { snippetCuts } from "./snippet";
import { watchUrl, type VideoMoment } from "./video";

export type QuoteSource = {
  /** What the row shows: the deputy's words (a quoted passage or a search excerpt), or the Câmara's summary (`summary`). */
  quote: string; summary?: boolean;
  /** The speaker, with the party and state on the day when known (else today's, as the row shows them). */
  name: string; party: string | null; uf: string | null;
  /** "YYYY-MM-DDTHH:MM", Brasília time, as stored. */
  startsAt: string;
  /** The speech's text page at the Câmara (the row's "Official record"), or null. */
  urlText: string | null;
  /** The speech's moment in the session's video, or null. */
  video: VideoMoment | null;
};

/**
 * The quote in quotation marks (the Câmara's summary labelled as theirs, never as the deputy's words), then who said it
 * (party-UF on the day) and when, as the page shows it (Brasília time), then the official record and, when the speech
 * was placed in the session's video, the YouTube link at its start.
 */
export function quoteWithSource(locale: MonitorLocale, s: QuoteSource): string {
  const quoted = `“${s.quote.replace(/\s+/g, " ").trim()}”`;
  const partyUf = [s.party, s.uf].filter(Boolean).join("-");
  const who = `${s.name}${partyUf ? ` (${partyUf})` : ""}, ${tm(locale, "copyQuote.when", { when: formatSpeechTime(s.startsAt, locale) })}`;
  const video = s.video ? watchUrl(s.video) : null;
  return [
    s.summary ? `${tm(locale, "copyQuote.summary")} ${quoted}` : quoted,
    who,
    s.urlText && tm(locale, "copyQuote.record", { url: s.urlText }),
    video && tm(locale, "copyQuote.video", { url: video }),
  ].filter(Boolean).join("\n");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A search row's excerpt as the row shows it: the matched words unmarked, fragments joined by "…", and "…" where the
 * excerpt is cut mid-text (`snippetCuts`). `summary`: the excerpt comes from the Câmara's summary, not the speech's text
 * (a row found only by meaning opens with the summary), so it is never copied as the deputy's words.
 */
export function shownExcerpt(snippet: string, summary: string | null, text: string | null): { quote: string; summary: boolean } {
  const cuts = snippetCuts(snippet, summary, text);
  const plain = snippet.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");
  const quote = `${cuts.before ? "… " : ""}${plain.replaceAll(" ... ", " … ")}${cuts.after ? " …" : ""}`;
  const body = squash(plain);
  const fromSummary = !!summary && !!body && squash(summary).includes(body) && !squash(text ?? "").includes(body);
  return { quote, summary: fromSummary };
}
