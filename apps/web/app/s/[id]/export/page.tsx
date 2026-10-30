import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSession } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

/** Export placeholder until the Export screen (Plan 2, Task 22). Reads the DB per request (inside Suspense). */
export default function ExportPage({ params }: PageProps<"/s/[id]/export">) {
  return (
    <Suspense fallback={<AppBar current="Export" />}>
      <ExportScreen params={params} />
    </Suspense>
  );
}

async function ExportScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await getSession(getServer().db, id);
  if (!session) notFound();

  return (
    <>
      <AppBar current="Export" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
        <p className="text-sm text-muted-foreground">Export is coming soon.</p>
      </main>
    </>
  );
}
