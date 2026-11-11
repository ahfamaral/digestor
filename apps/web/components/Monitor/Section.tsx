/** A titled list card with an empty state. */
export function Section({ title, count, empty, note, children }: { title: string; count?: string; empty: string | null; note?: string; children?: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="flex items-baseline gap-2 text-base font-semibold">
        {title}
        {count && <span className="font-mono text-xs font-normal text-muted-foreground">{count}</span>}
      </h2>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-white">{children}</ul>
      )}
    </section>
  );
}
