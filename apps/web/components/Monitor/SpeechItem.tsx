import Link from "next/link";
import type { SpeechHit, SpeechRow } from "@digestor/core/server";
import { formatSpeechTime, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref } from "@/lib/monitor/params";
import { ExternalLink } from "./ExternalLink";
import { Highlighted } from "./Highlighted";

/**
 * One official speech: who (with the party and state on the day, and "now …" when the party changed since), when, the
 * session phase, the Câmara's summary, labelled as theirs (or, for a search match, the matching passages), the full text
 * on demand and the link to the official text. A speech the Câmara published as an attached file says so instead.
 */
export function SpeechItem({ locale, speech, showMember }: { locale: MonitorLocale; speech: SpeechRow | SpeechHit; showMember?: boolean }) {
  const hit = "snippet" in speech ? speech : null;
  const party = hit ? (hit.partyThen ?? hit.member.party) : null;
  const uf = hit ? (hit.partyThen ? hit.ufThen : hit.member.uf) : null;
  const changed = hit && hit.partyThen && hit.member.party && hit.member.party !== hit.partyThen ? hit.member.party : null;
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
      </div>
      {hit ? (
        <p lang="pt-BR" className="break-words">
          <Highlighted text={hit.snippet} />
        </p>
      ) : (
        speech.summary && (
          <p className="break-words">
            <span className="mr-1.5 text-xs text-muted-foreground">{tm(locale, "speech.summaryLabel")}:</span>
            <span lang="pt-BR">{speech.summary}</span>
          </p>
        )
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
        <ExternalLink href={speech.urlText} className="w-fit text-xs">
          {tm(locale, "member.officialRecord")}
        </ExternalLink>
      )}
    </li>
  );
}
