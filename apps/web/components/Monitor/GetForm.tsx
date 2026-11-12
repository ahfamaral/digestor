"use client";

import { useState } from "react";

/**
 * A GET search form whose address stays clean: on submit, empty fields and fields left at their default
 * (`data-default`) are disabled for that one submission, so they don't appear as `from=&to=&phase=`. Without
 * JavaScript it is a plain GET form (the server ignores empty values anyway). `required`: a field that must not be
 * empty; the form then stays put, shows `hint` and focuses the field (the server says the same without JavaScript).
 */
export function GetForm({
  action, className, required, children,
}: { action: string; className?: string; required?: { name: string; hint: string }; children: React.ReactNode }) {
  const [missing, setMissing] = useState(false);
  return (
    <form
      role="search"
      action={action}
      method="get"
      className={className}
      onSubmit={(e) => {
        const need = required ? e.currentTarget.elements.namedItem(required.name) : null;
        if (need instanceof HTMLInputElement && !need.value.trim()) {
          e.preventDefault();
          setMissing(true);
          need.focus();
          return;
        }
        setMissing(false);
        const off: HTMLInputElement[] = [];
        for (const el of Array.from(e.currentTarget.elements)) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.name || el.disabled) continue;
          const atDefault = el instanceof HTMLInputElement && el.type === "radio" && el.checked && el.value === el.dataset.default;
          if (el.value === "" || atDefault) {
            el.disabled = true;
            off.push(el as HTMLInputElement);
          }
        }
        // The browser has read the fields once this handler returns; enable them again for Back (bfcache).
        setTimeout(() => off.forEach((el) => (el.disabled = false)), 0);
      }}
    >
      {children}
      {missing && required && <p role="status" className="text-sm text-muted-foreground">{required.hint}</p>}
    </form>
  );
}
