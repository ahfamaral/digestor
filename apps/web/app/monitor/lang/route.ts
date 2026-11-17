import { isMonitorLocale, MONITOR_LANG_COOKIE } from "@/lib/monitor/i18n";

const MONITOR_PATH = /^\/monitor(?:[/?#]|$)/;

/**
 * Only monitor paths on this site: "/monitor" or "/monitor/…" or "/monitor?…", never "//host" or a backslash trick.
 * Re-serialised through `URL`, so the Location header only carries ASCII (non-ASCII percent-encoded, tabs and newlines
 * dropped); anything that doesn't survive that is "/monitor", never a 500.
 */
function safeBack(back: string | null): string {
  if (!back || !MONITOR_PATH.test(back) || back.includes("\\")) return "/monitor";
  try {
    const u = new URL(back, "http://monitor.invalid");
    const path = u.pathname + u.search + u.hash;
    return u.host === "monitor.invalid" && MONITOR_PATH.test(path) && /^[\x21-\x7e]*$/.test(path) ? path : "/monitor";
  } catch {
    return "/monitor";
  }
}

/**
 * The monitor's language switch: remembers the choice for a year and goes back to the page it came from. The redirect
 * is a path, not an absolute URL: behind the proxy the request's own origin is the container's (0.0.0.0:3000).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  const headers = new Headers({ location: safeBack(url.searchParams.get("back")) });
  if (isMonitorLocale(to)) headers.append("set-cookie", `${MONITOR_LANG_COOKIE}=${to}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}
