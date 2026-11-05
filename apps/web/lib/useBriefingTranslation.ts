"use client";

import { useEffect, useState } from "react";
import type { TranslatedBriefingContent } from "@digestor/core";
import { translationFromResponse, type Translation } from "./briefingTranslation";
import { t } from "./i18n";

const POLL_MS = 3000;

export interface BriefingTranslation {
  /** The language picked in "Read in"; "" = the original. */
  readIn: string;
  /** The state of the picked language's translation (undefined for the original). */
  current: Translation | undefined;
  /** The translated briefing once it is ready, else null. */
  translated: TranslatedBriefingContent | null;
  /** `lang` for translated text (undefined while showing the original). */
  lang: string | undefined;
  pick: (code: string) => void;
  retry: () => void;
}

/**
 * "Read in": the picked language and its translation, created on first request and polled every 3 s while it is the
 * one being read. Translations already fetched stay in memory, so switching back is instant.
 */
export function useBriefingTranslation(analysisId: string): BriefingTranslation {
  const [readIn, setReadIn] = useState("");
  const [translations, setTranslations] = useState<Record<string, Translation>>({});
  const current = readIn ? translations[readIn] : undefined;
  const translated = current?.status === "ready" ? current.content : null;

  useEffect(() => {
    if (!readIn || current?.status !== "pending") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let next: Translation;
      try {
        const res = await fetch(`/api/analyses/${analysisId}/translations?language=${encodeURIComponent(readIn)}`);
        next = translationFromResponse("poll", res.status, await res.json().catch(() => null));
      } catch {
        next = { status: "pending" }; // network blip: keep polling
      }
      if (!cancelled) setTranslations((all) => ({ ...all, [readIn]: next }));
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readIn, current, analysisId]);

  async function request(code: string) {
    setTranslations((all) => ({ ...all, [code]: { status: "pending" } }));
    let next: Translation;
    try {
      const res = await fetch(`/api/analyses/${analysisId}/translations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      next = translationFromResponse("request", res.status, await res.json().catch(() => null));
    } catch {
      next = { status: "failed", error: t("preview.translationFailed") };
    }
    setTranslations((all) => ({ ...all, [code]: next }));
  }

  return {
    readIn,
    current,
    translated,
    lang: translated ? readIn : undefined,
    pick(code) {
      setReadIn(code);
      if (code && translations[code]?.status !== "ready" && translations[code]?.status !== "pending") void request(code);
    },
    retry() {
      if (readIn) void request(readIn);
    },
  };
}
