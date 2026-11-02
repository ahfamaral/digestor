"use client";

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import { closeMatches, type Person, type Range } from "@digestor/core";
import { errorMessage } from "@/lib/http";
import type { NamesData, VoiceLabel } from "@/lib/names";
import { t } from "@/lib/i18n";

const BTN =
  "inline-flex h-8 items-center rounded-md border border-border bg-white px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";
const SEARCH_MS = 250;

/** An HTTP failure whose message is the server's friendly sentence; any other thrown error stays in the log. */
class HttpError extends Error {}

type Option = { kind: "person"; person: Person } | { kind: "create"; name: string };

/**
 * The popover behind a speaker name: Confirm (a proposed name), Change… (search the people, or add a new one),
 * No name, and Only this part (with `range`, a change applies to that part of the video only). Escape closes it and
 * focus goes back to the name.
 */
export function NamePopover({
  sessionId,
  speakerId,
  label,
  names,
  range,
  trigger,
  startChanging = false,
}: {
  sessionId: string;
  speakerId: string;
  label: VoiceLabel;
  names: NamesData;
  range?: Range;
  trigger: ReactElement<Record<string, unknown>>;
  /** Open straight on the name search (a "Change…" button of its own). */
  startChanging?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(startChanging);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const [onlyThis, setOnlyThis] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // Typed text searches the people table (2+ characters); people already in this session answer at once.
  useEffect(() => {
    const q = query.trim();
    if (!changing || q.length < 2) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
        const body = (await res.json().catch(() => null)) as { persons?: Person[] } | null;
        if (!cancelled && res.ok) setFound(body?.persons ?? []);
      } catch {
        // the local matches still work
      }
    }, SEARCH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, changing]);

  const typed = query.trim();
  const options: Option[] = [];
  if (typed.length >= 1) {
    const seen = new Set<string>();
    for (const p of [...closeMatches(typed, names.persons), ...found]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      options.push({ kind: "person", person: p });
    }
    options.push({ kind: "create", name: typed });
  }

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setChanging(startChanging);
      setQuery("");
      setFound([]);
      setActive(0);
      setOnlyThis(false);
      setError(null);
    }
  }

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/names`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new HttpError(await errorMessage(res, t("names.failed")));
      reset(false);
      router.refresh();
    } catch (err) {
      console.error("names: save failed", err);
      setError(err instanceof HttpError ? err.message : t("names.failed"));
    } finally {
      setBusy(false);
    }
  }

  const part = onlyThis && range ? { startMs: range.startMs, endMs: range.endMs } : {};
  const pick = (o: Option) =>
    send(o.kind === "person" ? { action: "assign", speakerId, personId: o.person.id, ...part } : { action: "create", speakerId, displayName: o.name, ...part });

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length > 0) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[Math.min(active, options.length - 1)];
      if (o && !busy) void pick(o);
    }
  }

  const title = t("names.popoverTitle", { label: label.text });
  return (
    <Popover.Root open={open} onOpenChange={reset}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup
            initialFocus={changing ? inputRef : undefined}
            className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-white p-3 text-sm text-foreground shadow-lg outline-none"
          >
            <Popover.Title className="mb-2 text-[13px] font-semibold">{title}</Popover.Title>
            {!changing ? (
              <div className="flex flex-wrap gap-1.5">
                {label.proposed && (
                  <button type="button" className={BTN} disabled={busy} onClick={() => void send({ action: "confirm", speakerId })}>
                    {t("names.confirm")}
                  </button>
                )}
                <button
                  type="button"
                  className={BTN}
                  onClick={() => {
                    setChanging(true);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                >
                  {t("names.change")}
                </button>
                {label.badge !== null && (
                  <button type="button" className={BTN} disabled={busy} onClick={() => void send({ action: "anonymous", speakerId, ...part })}>
                    {t("names.noName")}
                  </button>
                )}
              </div>
            ) : (
              <div>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKey}
                  role="combobox"
                  aria-expanded={options.length > 0}
                  aria-controls={listId}
                  aria-activedescendant={options.length > 0 ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
                  aria-autocomplete="list"
                  aria-label={t("names.searchLabel", { label: label.text })}
                  placeholder={t("names.search")}
                  dir="auto"
                  className="h-8 w-full rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
                <ul id={listId} role="listbox" className="mt-1 max-h-48 overflow-y-auto">
                  {options.map((o, i) => (
                    <li
                      key={o.kind === "person" ? o.person.id : "create"}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === Math.min(active, options.length - 1)}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => void pick(o)}
                      className="cursor-pointer rounded-md px-2 py-1.5 text-[13px] aria-selected:bg-muted"
                    >
                      {o.kind === "person" ? (
                        <>
                          <span dir="auto">{o.person.displayName}</span>
                          {(o.person.party || o.person.role) && (
                            <span className="ml-1.5 text-xs text-muted-foreground">{[o.person.role, o.person.party].filter(Boolean).join(" · ")}</span>
                          )}
                        </>
                      ) : (
                        t("names.newPerson", { name: o.name })
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {range && (
              <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} className="size-3.5 accent-foreground" />
                {t("names.onlyThisPart")}
              </label>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-red-700">
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {t("names.saving")}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
