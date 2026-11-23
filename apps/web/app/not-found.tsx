import Link from "next/link";
import { AppBar } from "@/components/AppBar";
import { t } from "@/lib/i18n";

/** Branded 404 (also what `notFound()` shows for an unknown or malformed session id). */
export default function NotFound() {
  return (
    <>
      <AppBar />
      <main id="content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-xl font-bold tracking-tight">{t("notFound.title")}</h1>
        <Link
          href="/"
          className="mt-4 inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {t("common.backToSessions")}
        </Link>
      </main>
    </>
  );
}
