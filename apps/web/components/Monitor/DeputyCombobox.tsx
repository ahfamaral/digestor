"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref } from "@/lib/monitor/params";
import { panelStatus, worthAsking, type Suggestion } from "@/lib/monitor/suggest";
import { cn } from "@/lib/utils";

type Found = { rows: Suggestion[]; more: boolean; loading: boolean; error: boolean };
const NOTHING: Found = { rows: [], more: false, loading: false, error: false };

/**
 * Find a deputy by name: suggestions from 2 letters (debounced 200 ms, the previous request aborted), ↑/↓ and Enter or
 * a click open the deputy's page. Esc clears the text; a second Esc closes the panel.
 */
export function DeputyCombobox({ locale, size, label }: { locale: MonitorLocale; size: "lg" | "sm"; label: string }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<Found>(NOTHING);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!worthAsking(input)) return;
    const ctrl = new AbortController();
    setFound((f) => ({ ...f, loading: true, error: false }));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/monitor/deputies?q=${encodeURIComponent(input)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`suggestions answered ${res.status}`);
        const body = (await res.json()) as { rows: Suggestion[]; more: boolean };
        setFound({ rows: body.rows, more: body.more, loading: false, error: false });
      } catch {
        if (!ctrl.signal.aborted) setFound({ ...NOTHING, error: true });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [input, attempt]);

  const status = panelStatus({ q: input, loading: found.loading, error: found.error, rows: found.rows.length, more: found.more });
  const rows = status === "list" || status === "listMore" ? found.rows : [];
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
      // Base UI owns `open`; under 2 letters the panel is only hidden. Holding it closed through `open` made Base UI
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
        <Search className={cn("pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground", size === "lg" ? "size-5" : "size-4")} aria-hidden />
        <Combobox.Input
          aria-label={label}
          placeholder={tm(locale, "combobox.placeholder")}
          maxLength={120}
          onKeyDown={(e) => {
            // The first Esc clears the text; Base UI's own Esc (close) runs when there is none.
            if (e.key === "Escape" && input) {
              e.preventBaseUIHandler();
              setInput("");
              setFound(NOTHING);
            }
          }}
          className={cn(
            "w-full min-w-0 rounded-lg border border-input bg-white pr-3 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            size === "lg" ? "h-12 pl-10 text-base" : "h-9 pl-9 text-sm",
          )}
        />
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50 w-(--anchor-width)">
          <Combobox.Popup className={cn("overflow-hidden rounded-xl border border-border bg-white shadow-lg outline-none", status === "idle" && "hidden")}>
            <div className="flex h-9 items-center justify-between gap-2 border-b border-border bg-background px-4">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{tm(locale, "combobox.suggestions")}</span>
              {count && <span className="text-xs text-muted-foreground">{count}</span>}
            </div>
            <Combobox.Status className="contents">
              {status === "searching" && (
                <p className="flex items-center gap-1.5 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  {tm(locale, "combobox.searching")}
                </p>
              )}
              {status === "none" && <p className="px-4 py-3 text-sm font-medium">{tm(locale, "combobox.none")}</p>}
            </Combobox.Status>
            {status === "error" && (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span>{tm(locale, "combobox.error")}</span>
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="rounded font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                  {m.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the Câmara's photo, shown as published
                    <img src={m.photoUrl} alt="" width={32} height={32} referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full border border-border object-cover" />
                  ) : (
                    <span aria-hidden className="size-8 shrink-0 rounded-full border border-border bg-muted" />
                  )}
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
