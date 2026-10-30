import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_ID } from "@digestor/core";
import { createClip, createTrack, deleteClip, setMomentChecks, updateSession } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET as getChecks } from "./clips/[id]/checks/route";
import { GET as getTracks } from "./clips/[id]/tracks/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = () => new Request("http://localhost/x");
const checks = {
  argumentComplete: false, continuesWith: "Next.", unansweredQuestion: false, contextRisk: null, reportedSpeech: true, interpreter: false,
};

async function clipOf(ownerId = OWNER_ID) {
  const { sessionId, moments } = await seedReadySession(h.db);
  const m = moments[0]!;
  const clip = await createClip(h.db, { sessionId, ownerId, momentId: m.id, startMs: m.startMs, endMs: m.endMs, actor: "user" });
  return { sessionId, moment: m, clip };
}

describe("GET /api/clips/[id]/checks", () => {
  it("returns the moment's checks: null until they exist, then the stored checks", async () => {
    const { moment, clip } = await clipOf();
    const first = await getChecks(get(), ctx(clip.id));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ checks: null });
    await setMomentChecks(h.db, moment.id, checks);
    expect(await (await getChecks(get(), ctx(clip.id))).json()).toEqual({ checks });
  });

  it("answers 404 for unknown, deleted or someone else's clips and 409 while the video isn't ready", async () => {
    expect((await getChecks(get(), ctx("nope"))).status).toBe(404);
    const other = await clipOf("someone-else");
    expect((await getChecks(get(), ctx(other.clip.id))).status).toBe(404);
    const gone = await clipOf();
    await deleteClip(h.db, gone.clip.id, "user");
    expect((await getChecks(get(), ctx(gone.clip.id))).status).toBe(404);
    const { sessionId, clip } = await clipOf();
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    const res = await getChecks(get(), ctx(clip.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This video isn't ready yet." });
  });
});

describe("GET /api/clips/[id]/tracks", () => {
  it("lists the clip's subtitle tracks", async () => {
    const { clip } = await clipOf();
    expect(await (await getTracks(get(), ctx(clip.id))).json()).toEqual({ tracks: [] });
    await createTrack(h.db, clip.id, "de");
    await createTrack(h.db, clip.id, "en");
    const res = await getTracks(get(), ctx(clip.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tracks.map((t: { language: string; status: string }) => [t.language, t.status])).toEqual([
      ["de", "preparing"],
      ["en", "preparing"],
    ]);
  });

  it("answers 404 for someone else's clip and 409 while the video isn't ready", async () => {
    expect((await getTracks(get(), ctx("nope"))).status).toBe(404);
    const other = await clipOf("someone-else");
    expect((await getTracks(get(), ctx(other.clip.id))).status).toBe(404);
    const { sessionId, clip } = await clipOf();
    await updateSession(h.db, sessionId, { stage: "failed" });
    expect((await getTracks(get(), ctx(clip.id))).status).toBe(409);
  });
});
