import { cookies, headers } from "next/headers";
import { MONITOR_LANG_COOKIE, monitorLocale, type MonitorLocale } from "./i18n";
import type { Translate } from "./search";

/** The visitor's monitor language: the switch's cookie, else the browser's language. */
export async function requestLocale(): Promise<MonitorLocale> {
  return monitorLocale((await cookies()).get(MONITOR_LANG_COOKIE)?.value, (await headers()).get("accept-language"));
}

/** The query translator, when one is configured (none yet: the words are searched as typed). */
export function translator(): Translate | undefined {
  return undefined;
}
