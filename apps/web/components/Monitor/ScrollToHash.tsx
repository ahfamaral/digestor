"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Lands on the URL's #anchor (a filter, page or search link pointing at its section) once the records have streamed in
 * (Next, and the browser on a cold load, scroll before a streamed list exists and can stop short), then drops the
 * #anchor from the address. Chrome scrolls to an entry's fragment on Back/Forward, which would override the position
 * the reader left; without it the browser restores that position.
 */
export function ScrollToHash() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    let id = location.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // a malformed escape ("#%", a link cut mid-escape) names no section
      return;
    }
    if (!id) return;
    document.getElementById(id)?.scrollIntoView();
    window.history.replaceState(null, "", `${location.pathname}${location.search}`);
  }, [pathname, search]);
  return null;
}
