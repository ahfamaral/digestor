import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * A quiet ghost-button back link: chevron plus the page name, in ink colour, with a light pill on hover and focus.
 * `onClick` only from a client component (Monitor's `ReturnLink`).
 */
export function BackLink({ href, label, onClick }: { href: string; label: string; onClick?: React.MouseEventHandler<HTMLAnchorElement> }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="-ml-2.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
    >
      <ChevronLeft className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
