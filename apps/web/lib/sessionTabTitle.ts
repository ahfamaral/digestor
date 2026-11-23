import { displayTitle } from "@digestor/core";
import { getContextCard, getSession, type Session } from "@digestor/core/server";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";
import { pageTitle } from "@/lib/pageTitle";

/** A session page's tab title: the video's title as the page shows it (the context card's when the stored one is a file name), then the screen. */
export async function sessionTabTitle(id: string, screen: string | ((session: Session) => string)): Promise<string> {
  if (!isUuid(id)) return pageTitle();
  const db = getServer().db;
  const session = await getSession(db, id);
  if (!session) return pageTitle();
  const context = await getContextCard(db, id).catch(() => null);
  return pageTitle(displayTitle(session.title, context?.card.title.value), typeof screen === "string" ? screen : screen(session));
}
