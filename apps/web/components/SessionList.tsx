import Link from "next/link";
import { connection } from "next/server";
import { OWNER_ID, PROFILES, ProfileIdSchema } from "@digestor/core";
import { listSessionSummaries } from "@digestor/core/server";
import { Busy } from "@/components/ui/spinner";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";
import { clipCountText, sessionStatus } from "@/lib/sessionList";

const TONE = { normal: "text-foreground", waiting: "font-medium text-foreground", failed: "text-destructive" } as const;

/** The owner's sessions, newest activity first. Reads the DB per request (inside Suspense). */
export async function SessionList() {
  await connection();
  const { db } = getServer();
  const sessions = await listSessionSummaries(db, OWNER_ID);
  if (sessions.length === 0) return null;
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
  return (
    <section aria-labelledby="your-sessions" className="mt-10">
      <h2 id="your-sessions" className="mb-3 text-base font-semibold tracking-tight">{t("home.sessions")}</h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {sessions.map((s) => {
          const status = sessionStatus(s);
          const profile = ProfileIdSchema.safeParse(s.profile);
          return (
            <li key={s.id}>
              <Link href={`/s/${s.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                <span lang={s.language ?? undefined} dir="auto" className="truncate font-medium">{s.title}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {profile.success && <span>{PROFILES[profile.data].label}</span>}
                  <span role={status.busy ? "status" : undefined} className={`inline-flex items-center ${TONE[status.tone]}`}>
                    <Busy busy={status.busy}>{status.text}</Busy>
                  </span>
                  <span>{date.format(s.lastActivityAt)}</span>
                  {s.renderedClips > 0 && <span>{clipCountText(s.renderedClips)}</span>}
                  {s.videoRemoved && <span>{t("home.videoRemoved")}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
