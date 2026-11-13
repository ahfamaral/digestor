import { monitorEn, monitorPtBR, type MonitorKey, type MonitorMessages } from "@/messages/monitor";

export type MonitorLocale = "en" | "pt-BR";
export const MONITOR_LANG_COOKIE = "monitor_lang";

const catalogues: Record<MonitorLocale, MonitorMessages> = { en: monitorEn, "pt-BR": monitorPtBR };
export const isMonitorLocale = (v: unknown): v is MonitorLocale => v === "en" || v === "pt-BR";

function lookup(locale: MonitorLocale, key: string): string {
  let node: unknown = catalogues[locale];
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "string") throw new Error(`Unknown monitor message key: ${key}`);
  return node;
}

/** Monitor message with `{name}` interpolation, same rules as `t()`. */
export function tm(locale: MonitorLocale, key: MonitorKey, vars?: Record<string, string | number>): string {
  return lookup(locale, key).replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (vars && name in vars) return String(vars[name]);
    if (process.env.NODE_ENV !== "production") throw new Error(`Missing variable "${name}" for monitor message ${key}`);
    return placeholder;
  });
}

/** The interface language: the switch's cookie when valid, else Portuguese for a `pt*` browser, else English. */
export function monitorLocale(cookie: string | undefined, acceptLanguage: string | null): MonitorLocale {
  if (isMonitorLocale(cookie)) return cookie;
  const first = (acceptLanguage ?? "").split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return first === "pt" || first.startsWith("pt-") ? "pt-BR" : "en";
}

/** A Brasília wall-clock stamp ("2026-03-17T18:00") formatted as written, with no time-zone shift. */
export function formatSpeechTime(startsAt: string, locale: MonitorLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(`${startsAt}:00Z`));
}

/** A month ("2026-03") as "March 2026" / "março de 2026". */
export function formatMonth(month: string, locale: MonitorLocale): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

/** A calendar day ("2026-03-10") formatted as written. */
export function formatDay(day: string, locale: MonitorLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

export function formatCount(n: number, locale: MonitorLocale): string {
  return new Intl.NumberFormat(locale).format(n);
}
