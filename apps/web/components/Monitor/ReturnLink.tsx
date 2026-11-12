"use client";

import { useRouter } from "next/navigation";
import { BackLink } from "@/components/BackLink";

type NavigationEntries = { entries(): { url: string | null }[]; currentEntry: { index: number } | null };

/**
 * A back link that returns to the page the reader came from with its scroll position, when that page is the previous
 * history entry (Navigation API): the browser's own Back restores it. Otherwise (opened in a new tab, a language switch
 * in between, no Navigation API) it is a plain link to `href`, whose #anchor lands on the right list.
 */
export function ReturnLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <BackLink
      href={href}
      label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const nav = (window as { navigation?: NavigationEntries }).navigation;
        const index = nav?.currentEntry?.index ?? -1;
        const previous = index > 0 ? nav?.entries()[index - 1]?.url : null;
        if (!previous || new URL(previous).pathname !== new URL(href, location.href).pathname) return;
        e.preventDefault();
        router.back();
      }}
    />
  );
}
