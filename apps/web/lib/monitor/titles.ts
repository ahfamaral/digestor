import { tm, type MonitorLocale } from "./i18n";

/** A monitor page's browser title: what the page is about first, then "Câmara monitor · Digestor". */
export function monitorTitle(locale: MonitorLocale, ...about: (string | null | undefined)[]): string {
  return [...about.filter((s): s is string => !!s?.trim()), tm(locale, "title"), "Digestor"].join(" · ");
}
