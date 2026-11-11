import Link from "next/link";
import type { SpeechHit, SpeechRow } from "@digestor/core/server";
import { formatSpeechTime, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { Highlighted } from "./Highlighted";

/** One official speech: when, the session phase, the Câmara's summary (or, for a search match, the matching passages), the full text on demand. */
export function SpeechItem({ locale, speech, showMember }: { locale: MonitorLocale; speech: SpeechRow | SpeechHit; showMember?: boolean }) {
  const hit = "snippet" in speech ? speech : null;
  return (
    <li className="grid gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {showMember && hit && (
          <Link href={`/monitor/deputados/${hit.member.externalId}`} className="font-semibold underline-offset-2 hover:underline">
            {hit.member.name}
            {hit.member.party && <span className="font-normal text-muted-foreground"> · {[hit.member.party, hit.member.uf].filter(Boolean).join("-")}</span>}
          </Link>
        )}
        <time dateTime={speech.startsAt} className="font-mono text-xs text-muted-foreground">
          {formatSpeechTime(speech.startsAt, locale)}
        </time>
        {speech.phase && <span className="text-xs text-muted-foreground">{speech.phase}</span>}
      </div>
      {hit ? (
        <p lang="pt-BR" className="break-words">
          <Highlighted text={hit.snippet} />
        </p>
      ) : (
        speech.summary && (
          <p lang="pt-BR" className="break-words">
            {speech.summary}
          </p>
        )
      )}
      {speech.text ? (
        <details className="group">
          <summary className="w-fit cursor-pointer rounded text-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {tm(locale, "speech.showFullText")}
          </summary>
          <p lang="pt-BR" className="mt-2 break-words whitespace-pre-line">
            {speech.text}
          </p>
        </details>
      ) : (
        <p className="text-xs text-muted-foreground">{tm(locale, "speech.noText")}</p>
      )}
    </li>
  );
}
