import { Search } from "lucide-react";
import { MAX_QUERY } from "@/lib/monitor/search";

/** A plain GET form (works without JavaScript): `?q=` on `action`. */
export function SearchBox({ action, q, label, placeholder, button }: { action: string; q: string; label: string; placeholder: string; button: string }) {
  return (
    <form role="search" action={action} method="get" className="flex gap-2">
      <label htmlFor="monitor-q" className="sr-only">
        {label}
      </label>
      <input
        id="monitor-q"
        name="q"
        type="search"
        defaultValue={q}
        maxLength={MAX_QUERY}
        placeholder={placeholder}
        className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      />
      <button
        type="submit"
        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Search className="size-4" aria-hidden />
        {button}
      </button>
    </form>
  );
}
