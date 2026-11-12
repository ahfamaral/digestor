import { Suspense } from "react";
import { connection } from "next/server";
import { listMembers } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { DirectoryView } from "@/components/Monitor/DirectoryView";
import { tm } from "@/lib/monitor/i18n";
import { parseDirectory } from "@/lib/monitor/params";
import { requestLocale } from "@/lib/monitor/server";
import { monitorTitle } from "@/lib/monitor/titles";
import { getServer } from "@/lib/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return { title: monitorTitle(locale, tm(locale, "directory.title")) };
}

/** Every deputy, browsable without typing a name. Reads the DB per request (inside Suspense). */
export default function DirectoryPage({ searchParams }: PageProps<"/monitor/deputados">) {
  return (
    <>
      <AppBar area="monitor" skipTo="content" />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <Directory searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function Directory({ searchParams }: Pick<PageProps<"/monitor/deputados">, "searchParams">) {
  await connection();
  const [params, locale, members] = await Promise.all([
    searchParams.then(parseDirectory), requestLocale(), listMembers(getServer().db, "camara"),
  ]);
  return <DirectoryView locale={locale} params={params} members={members} />;
}
