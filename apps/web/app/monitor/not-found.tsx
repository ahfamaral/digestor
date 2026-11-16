import { Suspense } from "react";
import { MonitorAppBar } from "@/components/Monitor/MonitorAppBar";
import { BackLink } from "@/components/BackLink";
import { tm } from "@/lib/monitor/i18n";
import { requestLocale } from "@/lib/monitor/server";

/** The monitor's 404 (an unknown deputy or roll call): in the monitor's language, back to the monitor. */
export default function MonitorNotFound() {
  return (
    <>
      <MonitorAppBar />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 outline-none sm:px-6">
        <Suspense fallback={null}>
          <Body />
        </Suspense>
      </main>
    </>
  );
}

async function Body() {
  const locale = await requestLocale();
  return (
    <div lang={locale} className="grid gap-3">
      <BackLink href="/monitor" label={tm(locale, "member.back")} />
      <h1 className="text-xl font-bold tracking-tight">{tm(locale, "notFound.title")}</h1>
      <p className="text-sm text-muted-foreground">{tm(locale, "notFound.body")}</p>
    </div>
  );
}
