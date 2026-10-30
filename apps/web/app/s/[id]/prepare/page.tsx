import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSession } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/** Prepare clips placeholder until the Prepare screen (Plan 2, Task 21). Reads the DB per request (inside Suspense). */
export default function PreparePage({ params }: PageProps<"/s/[id]/prepare">) {
  return (
    <Suspense fallback={<AppBar current="Prepare" />}>
      <PrepareScreen params={params} />
    </Suspense>
  );
}

async function PrepareScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await getSession(getServer().db, id);
  if (!session) notFound();

  return (
    <>
      <AppBar current="Prepare" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
        <p className="text-sm text-muted-foreground">{t("session.prepareSoon")}</p>
      </main>
    </>
  );
}
