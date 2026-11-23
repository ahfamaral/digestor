"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, directoryHref } from "@/lib/monitor/params";
import { panelStatus, worthAsking, type Suggestion } from "@/lib/monitor/suggest";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";

/** The server's answer for one text and attempt (`key`); while the current key has none, the panel says "Searching…". */
type Answer = { key: string; rows: Suggestion[]; more: boolean; error: boolean };
const NO_ANSWER: Answer = { key: "", rows: [], more: false, error: false };
const answerKey = (input: string, attempt: number) => `${attempt}:${input}`;

/**
 * Find a deputy by name: suggestions from 2 letters (debounced 200 ms, the previous request aborted), ↑/↓ and Enter or
 * a click open the deputy's page. Esc clears the text and closes the panel; Esc on an empty box does nothing more (it
 * never reopens a hidden panel). The count is announced with the suggestions. Clicked while empty (or with 1 letter) the
 * panel says to type 2 letters and links the directory of all deputies.
 */
export function DeputyCombobox({ locale, size, label }: { locale: MonitorLocale; size: "lg" | "sm"; label: string }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER);
  const [attempt, setAttempt] = useState(0);
  const key = answerKey(input, attempt);
  // Loading is derived, not stored: the effect below only fetches and records the answer (no setState before the fetch).
  const found = answer.key === key ? answer : null;

  // The box always starts empty. Next keeps visited pages alive in a hidden <Activity> (cacheComponents), so the name
  // picked here would come back with Back; hiding a page runs effect clean-ups, which empty it. A page restored from the
  // browser's back-forward cache (`pageshow` persisted) empties too.
  useEffect(() => {
    const clear = () => {
      setInput("");
      setAnswer(NO_ANSWER);
      setOpen(false);
    };
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) clear();
    };
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("pageshow", restored);
      clear();
    };
  }, []);

  useEffect(() => {
    if (!worthAsking(input)) return;
    const ctrl = new AbortController();
    const asked = answerKey(input, attempt);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/monitor/deputies?q=${encodeURIComponent(input)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`suggestions answered ${res.status}`);
        const body = (await res.json()) as { rows: Suggestion[]; more: boolean };
        setAnswer({ key: asked, rows: body.rows, more: body.more, error: false });
      } catch {
        if (!ctrl.signal.aborted) setAnswer({ ...NO_ANSWER, key: asked, error: true });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [input, attempt]);

  const status = panelStatus({ q: input, loading: !found, error: !!found?.error, rows: found?.rows.length ?? 0, more: !!found?.more });
  const rows = status === "list" || status === "listMore" ? found!.rows : [];
  const count =
    status === "listMore" ? tm(locale, "combobox.more", { n: rows.length })
    : status === "list" ? (rows.length === 1 ? tm(locale, "combobox.countOne") : tm(locale, "combobox.count", { n: rows.length }))
    : null;

  return (
    <Combobox.Root<Suggestion>
      items={rows}
      filter={null}
      inputValue={input}
      onInputValueChange={(v) => {
        setInput(v);
        setOpen(true);
      }}
      // Base UI owns `open`; under 2 letters the panel shows the hint. Holding it closed through `open` made Base UI
      // reset the text, losing the first letter typed after clearing the box.
      open={open}
      onOpenChange={setOpen}
      onValueChange={(m) => {
        if (m) router.push(deputyHref(m.externalId));
      }}
      itemToStringLabel={(m) => m.name}
      isItemEqualToValue={(a, b) => a.externalId === b.externalId}
      autoHighlight
    >
      <div className="relative">
        <Search className={cn("pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground", "size-4")} aria-hidden />
        <Combobox.Input
          aria-label={label}
          placeholder={tm(locale, "combobox.placeholder")}
          maxLength={120}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventBaseUIHandler();
            setInput("");
            setAnswer(NO_ANSWER);
            setOpen(false);
          }}
          className={cn(
            "w-full min-w-0 rounded-lg border border-input bg-white pr-3 outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500",
            size === "lg" ? "h-10 pl-9 text-base md:text-sm" : "h-9 pl-9 text-sm",
          )}
        />
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50 w-(--anchor-width)">
          <Combobox.Popup className="overflow-hidden rounded-xl border border-border bg-white shadow-lg outline-none">
            {status === "idle" ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {tm(locale, "directory.typeOrBrowse")}{" "}
                <Link
                  href={directoryHref()}
                  onClick={() => setOpen(false)}
                  className="rounded font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
                >
                  {tm(locale, "directory.browseLower")}
                </Link>
              </p>
            ) : (
              <div className="flex h-9 items-center justify-between gap-2 border-b border-border bg-background px-4">
                <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{tm(locale, "combobox.suggestions")}</span>
                {count && <span className="text-xs text-muted-foreground">{count}</span>}
              </div>
            )}
            <Combobox.Status className="contents">
              {status === "searching" && (
                <p className="flex items-center gap-1.5 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  {tm(locale, "combobox.searching")}
                </p>
              )}
              {status === "none" && <p className="px-4 py-3 text-sm font-medium">{tm(locale, "combobox.none")}</p>}
              {count && <span className="sr-only">{count}</span>}
            </Combobox.Status>
            {status === "error" && (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span>{tm(locale, "combobox.error")}</span>
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="rounded font-medium underline underline-offset-2 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-stone-500"
                >
                  {tm(locale, "combobox.retry")}
                </button>
              </div>
            )}
            <Combobox.List className="max-h-[22rem] overflow-y-auto outline-none">
              {(m: Suggestion) => (
                <Combobox.Item
                  key={m.externalId}
                  value={m}
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5 outline-none data-highlighted:bg-muted"
                >
                  <Avatar name={m.name} photoUrl={m.photoUrl} size={32} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{m.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{[m.party, m.uf].filter(Boolean).join(" · ")}</span>
                  </span>
                  {!m.inOffice && (
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{tm(locale, "member.notInOffice")}</span>
                  )}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
