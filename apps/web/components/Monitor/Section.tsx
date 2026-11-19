/**
 * A titled list card with an empty state. `count` shows in parentheses after the title so it reads as a quantity.
 * `toolbar`: controls shown between the heading and the list (e.g. filters). `id`: the anchor that filter and page links
 * on the same page land on.
 */
export function Section({ id, title, count, empty, note, toolbar, children }: { id?: string; title: string; count?: string; empty: React.ReactNode; note?: string; toolbar?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="grid scroll-mt-14 gap-2 outline-none">
      <h2 className="flex items-baseline gap-2 text-base font-semibold">
        {title}
        {count && <span className="font-mono text-xs font-normal text-muted-foreground">({count})</span>}
      </h2>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {toolbar}
      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-white">{children}</ul>
      )}
    </section>
  );
}
