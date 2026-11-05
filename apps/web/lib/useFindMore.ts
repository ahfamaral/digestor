"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Granularity, MomentWithHighlights, SelectionStatus } from "@digestor/core";
import type { FocusChoice } from "@/components/Briefing/Controls";
import type { BriefingFilters, MomentView } from "./briefingFilters";
import { errorMessage } from "./http";
import { startRefreshLoop } from "./refreshLoop";
import { t } from "./i18n";

/** Where a "Find more" run stands for the focused person; "none" = never asked. */
interface FindMoreState {
  status: "none" | "pending" | "running" | "done" | "failed";
  momentCount: number;
  error: string | null;
  /** The run's id; its moments carry it as `findMoreRequestId`. */
  requestId?: string | null;
}
const POLL_MS = 3000;
const LEVELS: Granularity[] = ["exchange", "passage", "punchline"];
/** Below this many shown moments at the ticked levels, "Find more" is offered under the list too. */
const FEW = 5;

/**
 * "Find more moments with <person>" (Plan 3) for the focused person: the run's state per person, read from the server
 * when focus moves to a person and polled while it runs; a run that just finished refreshes the page's data.
 */
export function useFindMore({
  sessionId,
  filters,
  choices,
  moments,
  statuses,
  onDone,
}: {
  sessionId: string;
  filters: BriefingFilters;
  choices: FocusChoice[];
  moments: MomentWithHighlights[];
  statuses: Record<string, SelectionStatus>;
  onDone: () => void;
}) {
  const [findMore, setFindMore] = useState<Record<string, FindMoreState>>({});
  const seen = useRef<Record<string, FindMoreState["status"]>>({});
  // Bumped by every click: a status read that started before it is older than the click and is ignored.
  const seq = useRef(0);

  const person = filters.person;
  const name = person ? (choices.find((c) => c.kind === "person" && c.id === person)?.name ?? "") : "";
  const state = person ? findMore[person] : undefined;
  const busy = state?.status === "pending" || state?.status === "running";

  const load = useEffectEvent(async (personId: string) => {
    const at = seq.current;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/find-more?personId=${encodeURIComponent(personId)}`);
      if (!res.ok || at !== seq.current) return;
      const next = (await res.json()) as FindMoreState;
      const was = seen.current[personId];
      if (next.status === "none" && (was === "pending" || was === "running")) return; // our own request isn't visible yet
      seen.current[personId] = next.status;
      setFindMore((all) => ({ ...all, [personId]: next }));
      // A run that just finished brings new moments: re-read the page's data (the page keeps its state).
      if ((was === "pending" || was === "running") && next.status === "done") onDone();
    } catch {
      // a dropped poll: the next one retries
    }
  });
  // Opening a focused person shows a run already going (or done, or failed) for them.
  useEffect(() => {
    if (!person) return;
    const timer = setTimeout(() => void load(person), 0);
    return () => clearTimeout(timer);
  }, [person]);
  useEffect(() => {
    if (!person || !busy) return;
    return startRefreshLoop(() => void load(person), POLL_MS);
  }, [person, busy]);

  async function start() {
    if (!person || busy) return;
    const personId = person;
    seen.current[personId] = "pending";
    seq.current += 1;
    setFindMore((all) => ({ ...all, [personId]: { status: "pending", momentCount: 0, error: null } }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/find-more`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      if (res.ok || res.status === 409) return; // 409: one is already running; the poll follows it
      const error = await errorMessage(res, t("briefing.findMoreFailed"));
      setFindMore((all) => ({ ...all, [personId]: { status: "failed", momentCount: 0, error } }));
    } catch {
      setFindMore((all) => ({ ...all, [personId]: { status: "failed", momentCount: 0, error: t("briefing.findMoreFailed") } }));
    }
  }

  // "Found N moments with X.", plus how many sit at unticked levels (named) when some levels are unticked.
  let summary: string | null = null;
  if (state?.status === "done") {
    const unticked = LEVELS.filter((g) => !filters.levels.includes(g));
    const hiddenAll = state.requestId
      ? moments.filter((m) => m.origin === "find_more" && m.findMoreRequestId === state.requestId && !filters.levels.includes(m.granularity) && statuses[m.id] !== "approved").length
      : 0;
    const hidden = Math.min(hiddenAll, state.momentCount); // kept earlier moments aren't new
    summary =
      state.momentCount === 0
        ? t("briefing.findMoreNone")
        : (state.momentCount === 1 ? t("briefing.findMoreFoundOne", { name }) : t("briefing.findMoreFound", { n: state.momentCount, name })) +
          (hidden === 0
            ? ""
            : t(hidden === 1 ? "briefing.findMoreOtherLevelsOne" : "briefing.findMoreOtherLevels", { m: hidden, levels: unticked.map((g) => t(`granularity.${g}`)).join(" or ") }));
  }

  return {
    /** A person is focused (and has a name to show): offer the action. */
    offer: Boolean(person && name),
    busy,
    label: busy ? t("briefing.finding") : t("briefing.findMore", { name }),
    start: () => void start(),
    error: state?.status === "failed" ? state.error : null,
    summary,
    /** Fewer than 5 shown moments at the ticked levels (nested ones included): offer it under the list too. */
    fewAtLevel(views: MomentView[]): boolean {
      const count = (list: MomentView[]): number => list.reduce((n, v) => n + (filters.levels.includes(v.moment.granularity) ? 1 : 0) + count(v.children), 0);
      return count(views) < FEW;
    },
  };
}
