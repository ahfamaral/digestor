import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getRollCall } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { RollCallView } from "@/components/Monitor/RollCallView";
import { isRollCallId } from "@/lib/monitor/params";
import { requestLocale } from "@/lib/monitor/server";
import { getServer } from "@/lib/server";

/** A plenary roll call: votes by party at the time of the vote and the guidance. `id` is the Câmara's votação id. */
export default function RollCallPage({ params }: PageProps<"/monitor/votacoes/[id]">) {
  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        <Suspense fallback={null}>
          <RollCall params={params} />
        </Suspense>
      </main>
    </>
  );
}

async function RollCall({ params }: Pick<PageProps<"/monitor/votacoes/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!isRollCallId(id)) notFound();
  const rollCall = await getRollCall(getServer().db, id);
  if (!rollCall) notFound();
  return <RollCallView locale={await requestLocale()} rollCall={rollCall} />;
}
