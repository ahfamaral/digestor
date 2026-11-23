"use client";

import { useEffect, useRef, useState } from "react";
import { JumpLink } from "./JumpLink";
import { currentSection } from "@/lib/monitor/sectionSpy";

/**
 * Links to a long page's sections, kept in view at the top while scrolling (see `JumpLink`). `dense`: many short links
 * (letters). A row wider than the screen scrolls sideways under a faded right edge. The section being read is marked
 * (`aria-current="location"`) and kept in view in the row.
 */
export function SectionNav({ label, links, dense = false }: { label: string; links: { id: string; text: string }[]; dense?: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const ids = links.map((l) => l.id).join(" ");

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (nav.current?.getBoundingClientRect().bottom ?? 0) + 8;
      const tops = ids.split(" ").map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? null }));
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActive(currentSection(tops, line, atEnd));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids]);

  // Keep the marked link visible in a row that scrolls sideways (phones), without moving the page.
  useEffect(() => {
    const box = row.current;
    const link = active ? box?.querySelector<HTMLElement>(`[data-section="${CSS.escape(active)}"]`) : null;
    if (!box || !link) return;
    const left = link.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft || left + link.offsetWidth > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = Math.max(0, left - 16);
  }, [active]);

  return (
    <nav
      ref={nav}
      aria-label={label}
      className="sticky top-0 z-10 -mx-4 min-w-0 border-b border-border bg-background/95 backdrop-blur sm:-mx-6"
    >
      {/* Scrolls sideways when the links don't fit; the right edge fades so a cut row shows there is more. */}
      <div ref={row} className="overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] sm:px-6">
      <ul className={`flex py-1.5 pr-8 text-sm whitespace-nowrap ${dense ? "gap-0.5" : "gap-1"}`}>
        {links.map((l) => {
          const on = l.id === active;
          return (
            <li key={l.id} data-section={l.id}>
              <JumpLink
                id={l.id}
                current={on}
                className={`inline-flex min-h-8 items-center justify-center rounded-full ${on ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-hover active:bg-pressed hover:text-foreground"} ${dense ? "min-w-8 px-1.5" : "px-2.5"} outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1`}
              >
                {l.text}
              </JumpLink>
            </li>
          );
        })}
      </ul>
      </div>
    </nav>
  );
}
