import { Suspense } from "react";
import { AppBar } from "@/components/AppBar";
import { tm } from "@/lib/monitor/i18n";
import { requestLocale } from "@/lib/monitor/server";

/**
 * The top bar on the monitor's pages, in the monitor's language (the `monitor_lang` cookie, else the browser's). The
 * cookie is read per request, so the bar sits in its own Suspense: the English bar is the shell's fallback.
 */
export function MonitorAppBar() {
  return (
    <Suspense fallback={<AppBar area="monitor" skipTo="content" />}>
      <LocalizedBar />
    </Suspense>
  );
}

async function LocalizedBar() {
  const locale = await requestLocale();
  const labels = { sessions: tm(locale, "appBar.sessions"), monitor: tm(locale, "appBar.monitor"), skip: tm(locale, "appBar.skip"), lang: locale };
  return <AppBar area="monitor" skipTo="content" labels={labels} />;
}
