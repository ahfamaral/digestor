import { cookies, headers } from "next/headers";
import { MONITOR_LANG_COOKIE, monitorLocale, type MonitorLocale } from "./i18n";
import { loadRootEnv } from "@/lib/env";
import type { Translate } from "./search";
import { DEFAULT_TRANSLATE_MODEL, translateQuery } from "./translateQuery";

/** The visitor's monitor language: the switch's cookie, else the browser's language. */
export async function requestLocale(): Promise<MonitorLocale> {
  return monitorLocale((await cookies()).get(MONITOR_LANG_COOKIE)?.value, (await headers()).get("accept-language"));
}

/** The query translator when `OPENROUTER_API_KEY` is set; without it the words are searched as typed. */
export function translator(): Translate | undefined {
  if (process.env.OPENROUTER_API_KEY === undefined) loadRootEnv(); // host dev: the repo-root .env, read once
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;
  const model = process.env.OPENROUTER_MODEL_FAST || DEFAULT_TRANSLATE_MODEL;
  return (q) => translateQuery(q, { apiKey, model });
}
