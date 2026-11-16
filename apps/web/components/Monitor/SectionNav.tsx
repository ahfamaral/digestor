import { JumpLink } from "./JumpLink";

/**
 * Links to a long page's sections, kept in view at the top while scrolling (see `JumpLink`). `dense`: many short links
 * (letters). A row wider than the screen scrolls sideways under a faded right edge.
 */
export function SectionNav({ label, links, dense = false }: { label: string; links: { id: string; text: string }[]; dense?: boolean }) {
  return (
    <nav
      aria-label={label}
      className="sticky top-0 z-10 -mx-4 min-w-0 border-b border-border bg-background/95 backdrop-blur sm:-mx-6"
    >
      {/* Scrolls sideways when the links don't fit; the right edge fades so a cut row shows there is more. */}
      <div className="overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] sm:px-6">
      <ul className={`flex py-1.5 pr-8 text-sm whitespace-nowrap ${dense ? "gap-0.5" : "gap-1"}`}>
        {links.map((l) => (
          <li key={l.id}>
            <JumpLink
              id={l.id}
              className={`inline-block rounded-full py-1 text-muted-foreground ${dense ? "min-w-7 px-1.5 text-center" : "px-2.5"} outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand`}
            >
              {l.text}
            </JumpLink>
          </li>
        ))}
      </ul>
      </div>
    </nav>
  );
}
