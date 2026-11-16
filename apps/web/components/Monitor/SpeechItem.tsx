import Link from "next/link";
import { isWrittenOnly } from "@digestor/core";
import type { SpeechHit, SpeechRow } from "@digestor/core/server";
import { monitorClipEnabled } from "@/lib/monitor/clip";
import { formatSpeechTime, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref } from "@/lib/monitor/params";
import type { LandingSpeech } from "@/lib/monitor/search";
import { snippetCuts } from "@/lib/monitor/snippet";
import { ExternalLink } from "./ExternalLink";
import { Highlighted } from "./Highlighted";
import { ByMeaning } from "./MeaningNote";
import { SpeechVideo } from "./SpeechVideo";

/**
 * One official speech: who (with the party and state on the day, and "now …" when the party changed since), when, the
 * session phase, the Câmara's summary, labelled as theirs (or, for a search match, the matching passages), the full text
 * on demand and the link to the official text. A speech the Câmara published as an attached file says so instead.
 * A speech placed in the session's official video gets "Watch the speech" (and "Clip this speech" when
 * `MONITOR_CLIP_ENABLED=true`); one sent in writing says it wasn't spoken.
 * A topic-search row found only by the search by meaning (none of the searched words) is marked "Close in meaning".
 * A snippet cut mid-text gets "…" where it is cut; a speech with no summary yet says so. `videoNote`: this row's video
 * button carries the note about YouTube's cookies (the list's first video, `firstVideoRow`).
 */
export function SpeechItem({
  locale, speech, showMember, videoNote = true,
}: { locale: MonitorLocale; speech: SpeechRow | SpeechHit | LandingSpeech; showMember?: boolean; videoNote?: boolean }) {
  const hit = "snippet" in speech ? speech : null;
  const byMeaning = "byMeaning" in speech && speech.byMeaning;
  const party = hit ? (hit.partyThen ?? hit.member.party) : null;
  const uf = hit ? (hit.partyThen ? hit.ufThen : hit.member.uf) : null;
  const changed = hit && hit.partyThen && hit.member.party && hit.member.party !== hit.partyThen ? hit.member.party : null;
  const cuts = hit ? snippetCuts(hit.snippet, speech.summary, speech.text) : null;
  return (
    <li className="grid gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {showMember && hit && (
          <span>
            <Link href={deputyHref(hit.member.externalId)} className="font-semibold underline-offset-2 hover:underline">
              {hit.member.name}
            </Link>
            {party && <span className="text-muted-foreground"> · {[party, uf].filter(Boolean).join("-")}</span>}
            {changed && <span className="text-xs text-muted-foreground"> ({tm(locale, "speech.now", { party: changed })})</span>}
          </span>
        )}
        <time dateTime={speech.startsAt} className="font-mono text-xs text-muted-foreground">
          {formatSpeechTime(speech.startsAt, locale)}
        </time>
        {speech.phase && <span className="text-xs text-muted-foreground">{speech.phase}</span>}
        {byMeaning && <ByMeaning locale={locale} />}
      </div>
      {speech.video ? (
        <SpeechVideo
          locale={locale} video={speech.video} note={videoNote}
          clip={speech.speechKey ? { speechKey: speech.speechKey, enabled: monitorClipEnabled() } : undefined}
        />
      ) : (
        isWrittenOnly(speech.text) && <p className="text-xs text-muted-foreground">{tm(locale, "speech.writtenOnly")}</p>
      )}
      {hit ? (
        <p lang="pt-BR" className="break-words">
          {cuts?.before && "… "}
          <Highlighted text={hit.snippet.replaceAll(" ... ", " … ")} />
          {cuts?.after && " …"}
        </p>
      ) : speech.summary ? (
        <p className="break-words">
          <span className="mr-1.5 text-xs text-muted-foreground">{tm(locale, "speech.summaryLabel")}:</span>
          <span lang="pt-BR">{speech.summary}</span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{tm(locale, "speech.noSummary")}</p>
      )}
      {speech.textFile ? (
        <p className="text-xs text-muted-foreground">{tm(locale, "speech.attachedFile")}</p>
      ) : speech.text ? (
        <details className="group">
          <summary className="w-fit cursor-pointer rounded text-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
            {tm(locale, "speech.showFullText")}
          </summary>
          <p lang="pt-BR" className="mt-2 break-words whitespace-pre-line">
            {speech.text}
          </p>
        </details>
      ) : (
        <p className="text-xs text-muted-foreground">{tm(locale, "speech.noText")}</p>
      )}
      {speech.urlText && (
        <ExternalLink href={speech.urlText} className="w-fit text-xs font-medium underline">
          {tm(locale, "member.officialRecord")}
        </ExternalLink>
      )}
    </li>
  );
}
