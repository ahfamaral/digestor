import Link from "next/link";
import { BackLink } from "@/components/BackLink";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { byLetter, directoryOptions, filterDirectory, type DirectoryMember } from "@/lib/monitor/directory";
import { deputyHref, directoryHref, type DirectoryParams } from "@/lib/monitor/params";
import { Avatar } from "./Avatar";
import { FormSelect } from "./FormSelect";
import { GetForm } from "./GetForm";
import { LanguageSwitch } from "./LanguageSwitch";
import { SectionNav } from "./SectionNav";

const box = "size-4 rounded border-input accent-brand outline-none focus-visible:ring-2 focus-visible:ring-stone-500";

/**
 * `/monitor/deputados`: every deputy without typing a name. In office by default (`former` adds the others), narrowed by
 * today's party and state, grouped by first letter with a sticky letter row. Alphabetical only: no counts of activity,
 * no ranking. Each row opens the deputy's page. `words`: with a party picked, that party's "Words used more than the
 * chamber" (streamed in by the page), above the list.
 */
export function DirectoryView({
  locale, params, members, words,
}: { locale: MonitorLocale; params: DirectoryParams; members: DirectoryMember[]; words?: React.ReactNode }) {
  const shown = filterDirectory(members, params);
  const groups = byLetter(shown);
  const options = directoryOptions(members, params);
  const filtered = !!(params.party || params.uf || params.former);
  return (
    <div lang={locale} className="grid gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <BackLink href="/monitor" label={tm(locale, "member.back")} />
          <LanguageSwitch locale={locale} back={directoryHref(params)} />
        </div>
        <div className="grid gap-1">
          <h1 className="text-xl font-bold tracking-tight">{tm(locale, "directory.title")}</h1>
          <p className="text-sm text-muted-foreground">{tm(locale, "directory.intro")}</p>
        </div>
      </div>

      <GetForm label={tm(locale, "forms.directory")} action="/monitor/deputados" className="grid gap-3 rounded-xl border border-border bg-white p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormSelect name="party" label={tm(locale, "directory.party")} anyLabel={tm(locale, "filters.any")} options={options.parties} value={params.party} />
          <FormSelect name="uf" label={tm(locale, "directory.uf")} anyLabel={tm(locale, "filters.any")} options={options.ufs} value={params.uf} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="former" value="1" defaultChecked={params.former} className={box} />
            {tm(locale, "directory.former")}
          </label>
          <div className="ml-auto flex items-center gap-4 text-sm">
            {filtered && (
              <Link href={directoryHref()} className="inline-block rounded px-1 py-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
                {tm(locale, "directory.clear")}
              </Link>
            )}
            <button
              type="submit"
              className="inline-flex h-9 shrink-0 items-center rounded-lg bg-brand px-4 font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-stone-500"
            >
              {tm(locale, "directory.apply")}
            </button>
          </div>
        </div>
      </GetForm>

      {params.party && words}

      <div className="grid gap-4">
        <p className="text-sm font-medium">
          {shown.length === 1 ? tm(locale, "directory.countOne") : tm(locale, "directory.count", { n: formatCount(shown.length, locale) })}
        </p>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm(locale, "directory.none")}</p>
        ) : (
          <>
            {groups.length > 1 && <SectionNav dense label={tm(locale, "directory.letters")} links={groups.map((g) => ({ id: letterId(g.letter), text: g.letter }))} />}
            {groups.map((g) => (
              <section key={g.letter} id={letterId(g.letter)} tabIndex={-1} aria-labelledby={`${letterId(g.letter)}-h`} className="grid scroll-mt-14 gap-2 outline-none">
                <h2 id={`${letterId(g.letter)}-h`} className="text-sm font-semibold text-muted-foreground">{g.letter}</h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {g.members.map((m) => (
                    <li key={m.externalId}>
                      <DirectoryRow locale={locale} member={m} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** A letter's section id ("#" names go under `letter-other`). */
const letterId = (letter: string) => `letter-${letter === "#" ? "other" : letter}`;

function DirectoryRow({ locale, member: m }: { locale: MonitorLocale; member: DirectoryMember }) {
  return (
    <Link
      href={deputyHref(m.externalId)}
      className="flex h-full items-center gap-3 rounded-lg border border-border bg-white px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-stone-500"
    >
      <Avatar name={m.name} photoUrl={m.photoUrl} size={40} lazy />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold break-words">{m.name}</span>
        <span className="text-xs text-muted-foreground">{[m.party, m.uf].filter(Boolean).join(" · ")}</span>
      </span>
      {!m.inOffice && <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{tm(locale, "member.notInOffice")}</span>}
    </Link>
  );
}
