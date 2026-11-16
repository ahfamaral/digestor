import type { Presence as PresenceRecord } from "@digestor/core/server";
import { formatSpeechTime, tm, type MonitorLocale } from "@/lib/monitor/i18n";

/**
 * The presence record as published: "Present at N of M…", the sessions with no presence recorded, and (only when N < M)
 * why that list explains nothing. Never a percentage, a comparison, a ranking or a colour; never "absent".
 */
export function Presence({ locale, presence, year }: { locale: MonitorLocale; presence: PresenceRecord | null; year: number }) {
  return (
    <section id="presence" tabIndex={-1} className="grid scroll-mt-14 gap-2 outline-none" aria-labelledby="presence-title">
      <h2 id="presence-title" className="text-base font-semibold">{tm(locale, "presence.title")}</h2>
      {presence === null ? (
        <p className="text-sm text-muted-foreground">{tm(locale, "presence.unavailable")}</p>
      ) : (
        <div className="grid gap-2 rounded-xl border border-border bg-white px-4 py-3 text-sm">
          <p>{tm(locale, "presence.sentence", { present: presence.present, sessions: presence.sessions, year })}</p>
          {presence.missing.length > 0 && (
            <details>
              <summary className="w-fit cursor-pointer rounded font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
                {tm(locale, "presence.noneRecorded", { n: presence.missing.length })}
              </summary>
              <ul className="mt-2 grid gap-1">
                {presence.missing.map((s) => (
                  <li key={s.id} className="grid gap-x-3 sm:grid-cols-[auto_1fr]">
                    <time dateTime={s.startsAt} className="font-mono text-xs text-muted-foreground">{formatSpeechTime(s.startsAt, locale)}</time>
                    <span lang="pt-BR" className="line-clamp-2 break-words">{s.description}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {presence.present < presence.sessions && <p className="text-xs text-muted-foreground">{tm(locale, "presence.note")}</p>}
        </div>
      )}
    </section>
  );
}
