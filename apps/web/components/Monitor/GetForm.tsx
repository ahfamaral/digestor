"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/**
 * The address a GET form sends: fields with an empty value, and radios left at their default (`defaults`, the
 * "name=value" pairs of `data-default` radios), are left out so the address stays clean (`from=&to=&phase=`).
 */
export function formQuery(entries: Iterable<[string, string]>, defaults: ReadonlySet<string> = new Set()): string {
  const query = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value === "" || defaults.has(`${name}=${value}`)) continue;
    query.append(name, value);
  }
  return query.toString();
}

let landing: string | null = null;

/**
 * Scrolls to a section and keeps it there while the records stream in and move it, for a few seconds or until the
 * reader scrolls or touches the page. Independent of any component, which the page may remount meanwhile.
 */
function land(id: string) {
  const go = () => document.getElementById(id)?.scrollIntoView();
  go();
  const types = ["wheel", "touchstart", "keydown", "pointerdown"];
  const observer = new ResizeObserver(go);
  observer.observe(document.body);
  const timer = setTimeout(stop, 4000);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of types) window.removeEventListener(type, stop);
  }
  for (const type of types) window.addEventListener(type, stop, { once: true });
}

/**
 * A GET search form whose address stays clean. With JavaScript, a submit is an App Router navigation (the page stays
 * on screen while the next one renders; `scroll: false`) to the action plus `formQuery`; a `#section` in the action is
 * scrolled to once it has rendered; it is never pushed, so the address never shows it.
 * Without JavaScript it is a plain GET form (the server ignores empty values anyway). `required`: a field that must
 * not be empty; the form then stays put, shows `hint` and focuses the field (the server says the same without JavaScript).
 */
export function GetForm({
  action, className, required, label, children,
}: { action: string; className?: string; required?: { name: string; hint: string }; /** Names the search landmark (a page with several). */ label?: string; children: React.ReactNode }) {
  const [missing, setMissing] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [path, hash] = action.split("#") as [string, string | undefined];

  useEffect(() => {
    // The page may remount this form for a new search (a Suspense key), so the target is kept at module level.
    if (landing && !pending) {
      const id = landing;
      landing = null;
      land(id);
    }
  }, [pending]);

  return (
    <form
      role="search"
      aria-label={label}
      action={action}
      method="get"
      className={`group/get transition-opacity aria-busy:opacity-70 ${className ?? ""}`}
      aria-busy={pending || undefined}
      onSubmit={(e) => {
        const form = e.currentTarget;
        const need = required ? form.elements.namedItem(required.name) : null;
        if (need instanceof HTMLInputElement && !need.value.trim()) {
          e.preventDefault();
          setMissing(true);
          need.focus();
          return;
        }
        setMissing(false);
        e.preventDefault();
        const defaults = new Set<string>();
        for (const el of Array.from(form.elements)) {
          if (el instanceof HTMLInputElement && el.type === "radio" && el.checked && el.name && el.value === el.dataset.default) {
            defaults.add(`${el.name}=${el.value}`);
          }
        }
        const entries = Array.from(new FormData(form), ([k, v]): [string, string] => [k, typeof v === "string" ? v : ""]);
        const query = formQuery(entries, defaults);
        landing = hash ?? null;
        startTransition(() => router.push(`${path}${query ? `?${query}` : ""}`, { scroll: false }));
      }}
    >
      {children}
      {missing && required && <p role="status" className="text-sm text-muted-foreground">{required.hint}</p>}
    </form>
  );
}
