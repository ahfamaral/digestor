import { isMonitorLocale, MONITOR_LANG_COOKIE } from "@/lib/monitor/i18n";

/** Only monitor paths on this site: "/monitor" or "/monitor/…" or "/monitor?…", never "//host" or a backslash trick. */
function safeBack(back: string | null): string {
  if (!back || !/^\/monitor(?:[/?#]|$)/.test(back) || back.includes("\\")) return "/monitor";
  return back;
}

/** The monitor's language switch: remembers the choice for a year and goes back to the page it came from. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  const headers = new Headers({ location: new URL(safeBack(url.searchParams.get("back")), url.origin).toString() });
  if (isMonitorLocale(to)) headers.append("set-cookie", `${MONITOR_LANG_COOKIE}=${to}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}
