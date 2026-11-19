import { parseYouTubeUrl, personAt } from "@digestor/core";
import { t } from "./i18n";
import type { NamesData, Voice } from "./names";

/** A position as h:mm:ss ("0:12:03"), as a citation writes it. */
export function clockTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Where to check a moment in its source: the YouTube video at that second (a session cut from a part of the video,
 * a Câmara speech clipped from the monitor, adds the part's start). Null for uploads or a link that isn't a video.
 */
export function sourceLink(
  session: { source: "upload" | "youtube"; sourceUrl: string | null; sourceStartMs: number | null },
  atMs: number,
): string | null {
  if (session.source !== "youtube" || !session.sourceUrl) return null;
  try {
    const { url } = parseYouTubeUrl(session.sourceUrl);
    return `${url}&t=${Math.floor(((session.sourceStartMs ?? 0) + atMs) / 1000)}s`;
  } catch {
    return null;
  }
}

/**
 * Who speaks in a quoted moment, as the session names them: a confirmed name as is, an unconfirmed one marked so; in a
 * sensitive profile confirmed names only. Voices without a name (or marked "No name") are left out, never "Speaker A".
 */
export function quoteSpeakers(names: NamesData, voices: Voice[], sensitive: boolean): string[] {
  const byId = new Map(names.persons.map((p) => [p.id, p.displayName.trim()]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of voices) {
    const res = personAt(names.attributions, v.speakerId, v.atMs);
    if (res.kind !== "named" || (sensitive && !res.confirmed) || seen.has(res.personId)) continue;
    const name = byId.get(res.personId);
    if (!name) continue;
    seen.add(res.personId);
    out.push(res.confirmed ? name : t("briefing.copyQuote.unconfirmed", { name }));
  }
  return out;
}

/** The text "Copy quote with source" puts on the clipboard: the quote, who said it, the video, when, and the link. */
export function quoteWithSource(q: { quote: string; speakers: string[]; title: string; startMs: number; endMs: number; link: string | null }): string {
  const range = t("briefing.copyQuote.range", { start: clockTime(q.startMs), end: clockTime(q.endMs) });
  const cite = q.speakers.length > 0
    ? t("briefing.copyQuote.cite", { speakers: new Intl.ListFormat("en", { type: "conjunction" }).format(q.speakers), title: q.title, range })
    : t("briefing.copyQuote.citeNoSpeaker", { title: q.title, range });
  return [t("briefing.copyQuote.quote", { quote: q.quote }), cite, ...(q.link ? [q.link] : [])].join("\n");
}
