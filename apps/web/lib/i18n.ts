import { en, type MessageKey } from "@/messages/en";

export type { MessageKey };

function lookup(key: string): string {
  let node: unknown = en;
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "string") throw new Error(`Unknown message key: ${key}`);
  return node;
}

/** English message with `{name}` interpolation. A missing var throws outside production; in production the placeholder stays. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return lookup(key).replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (vars && name in vars) return String(vars[name]);
    if (process.env.NODE_ENV !== "production") throw new Error(`Missing variable "${name}" for message ${key}`);
    return placeholder;
  });
}

export function formatDateTime(d: Date | string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
}

/** English name of a BCP-47 language code ("pt" → "Portuguese"); the code itself when unknown. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
