"use client";

/**
 * A link to a section of the same page. A click scrolls there and moves focus to it without adding a history entry: an
 * #anchor in the address would make Back jump to it instead of restoring where the reader was (see ScrollToHash). The
 * plain href still works without JavaScript; the target needs `tabIndex={-1}` to take focus.
 */
export function JumpLink({ id, className, current = false, children }: { id: string; className?: string; current?: boolean; children: React.ReactNode }) {
  return (
    <a
      href={`#${id}`}
      aria-current={current ? "location" : undefined}
      onClick={(e) => {
        const target = document.getElementById(id);
        if (!target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        target.scrollIntoView();
        target.focus({ preventScroll: true });
      }}
      className={className}
    >
      {children}
    </a>
  );
}
