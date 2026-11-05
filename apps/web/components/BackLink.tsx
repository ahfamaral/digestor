import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/** A quiet ghost-button back link: chevron plus the page name, in ink colour, with a light pill on hover and focus. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-ml-2.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-brand"
    >
      <ChevronLeft className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
