import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/** English | Português: plain links through `/monitor/lang`, which sets the cookie and comes back to `back`. */
export function LanguageSwitch({ locale, back }: { locale: MonitorLocale; back: string }) {
  const options: [MonitorLocale, string, string][] = [["en", tm(locale, "lang.en"), "en"], ["pt-BR", tm(locale, "lang.pt"), "pt-BR"]];
  return (
    <nav aria-label={tm(locale, "lang.label")} className="flex shrink-0 items-center gap-1 text-sm">
      {options.map(([value, label, lang], i) => (
        <span key={value} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-muted-foreground">|</span>}
          {value === locale ? (
            <span aria-current="true" lang={lang} className="px-1 font-semibold">
              {label}
            </span>
          ) : (
            <a
              href={`/monitor/lang?to=${value}&back=${encodeURIComponent(back)}`}
              lang={lang}
              className="rounded px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {label}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}
