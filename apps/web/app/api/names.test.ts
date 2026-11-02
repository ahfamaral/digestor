import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_ID, type Word } from "@digestor/core";
import {
  completeAnalysisVersion, createCustomPerson, createSession, findPersonByName, listAttributions, replaceAiAttributions, saveTranscript,
  getAnalysisVersion, startAnalysisVersion, updateSession,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { GET as getNames, POST as postNames } from "./sessions/[id]/names/route";
import { GET as getPersons } from "./persons/route";
import { namesChangedSince } from "@/lib/namesServer";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  postNames(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), ctx(id));
const proposed = (speakerId: string, personId: string) => ({
  speakerId, startMs: null, endMs: null, personId, status: "proposed" as const, confidence: 0.8, evidence: { kind: "none" as const },
});

async function twoVoiceSession() {
  const s = await createSession(h.db, { title: "Two", source: "upload" });
  await updateSession(h.db, s.id, { stage: "ready", progress: 100, profile: "interview", language: "en", durationMs: 10_000 });
  const words: Word[] = ["A", "B", "C"].map((speaker, i) => ({
    text: `w${i}.`, startMs: i * 1000, endMs: i * 1000 + 900, speaker, confidence: 0.9,
  }));
  await saveTranscript(h.db, s.id, { language: "en", languageConfidence: 1, durationMs: 10_000, words });
  return s.id;
}

describe("names", () => {
  it("names: assign, create, anonymous and confirm write human rows", async () => {
    const { sessionId } = await seedReadySession(h.db);
    // The test DB persists between runs: reuse a "Lula" left over from before.
    const lula = (await findPersonByName(h.db, "Lula")) ?? (await createCustomPerson(h.db, { displayName: "Lula", createdBy: OWNER_ID }));
    const ana = await createCustomPerson(h.db, { displayName: "Ana Souza", createdBy: OWNER_ID });

    let res = await post(sessionId, { action: "assign", speakerId: "A", personId: ana.id });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.attributions).toHaveLength(1);
    expect(body.attributions[0]).toMatchObject({ speakerId: "A", personId: ana.id, source: "human", startMs: null });
    expect(body.persons.map((p: { id: string }) => p.id)).toEqual([ana.id]);

    res = await post(sessionId, { action: "create", speakerId: "A", displayName: "Lula", startMs: 1000, endMs: 5000 });
    body = await res.json();
    // "New person" always creates one, even when the name exists: reusing a person is the close-match options' job.
    const ranged = body.attributions.find((a: { startMs: number | null }) => a.startMs === 1000);
    expect(ranged.personId).not.toBe(lula.id);
    expect(body.persons.find((p: { id: string }) => p.id === ranged.personId)).toMatchObject({ displayName: "Lula", kind: "custom" });

    res = await post(sessionId, { action: "create", speakerId: "A", displayName: "Brand New", startMs: 6000, endMs: 8000 });
    body = await res.json();
    expect(body.persons.find((p: { displayName: string }) => p.displayName === "Brand New")?.kind).toBe("custom");

    res = await post(sessionId, { action: "anonymous", speakerId: "A", startMs: 6000, endMs: 8000 });
    body = await res.json();
    expect(body.attributions.find((a: { startMs: number | null }) => a.startMs === 6000)).toMatchObject({ personId: null, status: "anonymous" });

    const got = await (await getNames(new Request("http://localhost/x"), ctx(sessionId))).json();
    expect(got.attributions).toHaveLength(3);

    // confirm: a proposed whole-voice name becomes a human row
    const other = await createCustomPerson(h.db, { displayName: "Bia Lima", createdBy: OWNER_ID });
    const sid = await twoVoiceSession();
    await replaceAiAttributions(h.db, sid, "transcript", [proposed("B", other.id)]);
    res = await post(sid, { action: "confirm", speakerId: "B" });
    expect(res.status).toBe(200);
    const rows = await listAttributions(h.db, sid);
    expect(rows.find((a) => a.source === "human")).toMatchObject({ speakerId: "B", personId: other.id, status: "confirmed" });
  });

  it("names: confirm_all confirms only proposed single-person voices", async () => {
    const sid = await twoVoiceSession();
    const p1 = await createCustomPerson(h.db, { displayName: "Dora Alves", createdBy: OWNER_ID });
    const p2 = await createCustomPerson(h.db, { displayName: "Edu Reis", createdBy: OWNER_ID });
    await replaceAiAttributions(h.db, sid, "transcript", [proposed("A", p1.id), proposed("B", p1.id), proposed("B", p2.id)]);
    const res = await post(sid, { action: "confirm_all" });
    expect(res.status).toBe(200);
    const humans = (await listAttributions(h.db, sid)).filter((a) => a.source === "human");
    expect(humans.map((a) => [a.speakerId, a.personId])).toEqual([["A", p1.id]]);
  });

  it("names: a voice with ranged rows is confirmed part by part", async () => {
    const sid = await twoVoiceSession();
    const p1 = await createCustomPerson(h.db, { displayName: "Gil Moura", createdBy: OWNER_ID });
    const p2 = await createCustomPerson(h.db, { displayName: "Hana Pires", createdBy: OWNER_ID });
    await replaceAiAttributions(h.db, sid, "transcript", [
      { ...proposed("A", p1.id), startMs: 0, endMs: 900 },
      { ...proposed("B", p2.id) },
    ]);
    let res = await post(sid, { action: "confirm", speakerId: "A" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Confirm each part of this voice separately." });
    res = await post(sid, { action: "confirm_all" });
    expect(res.status).toBe(200);
    const humans = (await listAttributions(h.db, sid)).filter((a) => a.source === "human");
    expect(humans.map((a) => [a.speakerId, a.personId])).toEqual([["B", p2.id]]);
  });

  it("names: a human \"Only this part\" row does not block Confirm of the whole voice", async () => {
    const sid = await twoVoiceSession();
    const p1 = await createCustomPerson(h.db, { displayName: "Kai Todo", createdBy: OWNER_ID });
    const p2 = await createCustomPerson(h.db, { displayName: "Lia Parte", createdBy: OWNER_ID });
    await replaceAiAttributions(h.db, sid, "transcript", [proposed("A", p1.id), proposed("B", p1.id)]);
    expect((await post(sid, { action: "assign", speakerId: "A", personId: p2.id, startMs: 0, endMs: 900 })).status).toBe(200);
    expect((await post(sid, { action: "assign", speakerId: "B", personId: p2.id, startMs: 1000, endMs: 1900 })).status).toBe(200);
    let res = await post(sid, { action: "confirm", speakerId: "A" });
    expect(res.status).toBe(200);
    res = await post(sid, { action: "confirm_all" });
    expect(res.status).toBe(200);
    const humans = (await listAttributions(h.db, sid)).filter((a) => a.source === "human" && a.startMs === null);
    expect(humans.map((a) => [a.speakerId, a.personId]).sort()).toEqual([["A", p1.id], ["B", p1.id]]);
  });

  it("names: a range needs both ends and start < end", async () => {
    const { sessionId } = await seedReadySession(h.db);
    const p = await createCustomPerson(h.db, { displayName: "Fay Cruz", createdBy: OWNER_ID });
    for (const range of [{ startMs: 1000 }, { endMs: 1000 }, { startMs: 5000, endMs: 5000 }, { startMs: 6000, endMs: 5000 }]) {
      const res = await post(sessionId, { action: "assign", speakerId: "A", personId: p.id, ...range });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Send both start and end, with start before end." });
    }
  });

  it("names: 409 before the transcript exists", async () => {
    const s = await createSession(h.db, { title: "New", source: "upload" });
    const res = await post(s.id, { action: "anonymous", speakerId: "A" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Names can be set once the transcript is ready." });
  });

  it("names: unknown session", async () => {
    for (const id of ["nope", "00000000-0000-4000-8000-000000000000"]) {
      const res = await post(id, { action: "confirm_all" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found." });
    }
    expect((await getNames(new Request("http://localhost/x"), ctx("nope"))).status).toBe(404);
  });
});

describe("names changed notice", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  // names_at comes from the database clock (the host's may differ from the container's): take it from a real version.
  const version = async (sid: string) => {
    const v = await startAnalysisVersion(h.db, sid, { profile: "interview", reason: "test", models: {}, promptVersions: {} });
    await completeAnalysisVersion(h.db, v.id);
    return (await getAnalysisVersion(h.db, v.id))!.namesAt;
  };
  it("a confirmation of the AI's name is no change; a rename or No name is", async () => {
    const sid = await twoVoiceSession();
    const p1 = await createCustomPerson(h.db, { displayName: "Iara Notada", createdBy: OWNER_ID });
    await replaceAiAttributions(h.db, sid, "transcript", [proposed("A", p1.id), proposed("B", p1.id)]);
    await tick();
    const namesAt = await version(sid);
    await tick();
    expect(await namesChangedSince(h.db, sid, namesAt)).toBe(false);
    expect((await post(sid, { action: "confirm_all" })).status).toBe(200);
    expect(await namesChangedSince(h.db, sid, namesAt)).toBe(false);
    await post(sid, { action: "anonymous", speakerId: "B" });
    expect(await namesChangedSince(h.db, sid, namesAt)).toBe(true);
    await tick();
    expect(await namesChangedSince(h.db, sid, await version(sid))).toBe(false); // a later version was written with these names
    const p2 = await createCustomPerson(h.db, { displayName: "Jonas Novo", createdBy: OWNER_ID });
    await post(sid, { action: "assign", speakerId: "A", personId: p2.id });
    expect(await namesChangedSince(h.db, sid, namesAt)).toBe(true);
  });
});

describe("persons", () => {
  it("persons: search returns at most 10 and needs 2+ characters", async () => {
    for (let i = 0; i < 12; i++) await createCustomPerson(h.db, { displayName: `Zebulon ${i}`, createdBy: OWNER_ID });
    const q = (s: string) => getPersons(new Request(`http://localhost/api/persons?q=${encodeURIComponent(s)}`));
    expect((await (await q("zebulon")).json()).persons).toHaveLength(10);
    expect(await (await q("z")).json()).toEqual({ persons: [] });
    expect(await (await getPersons(new Request("http://localhost/api/persons"))).json()).toEqual({ persons: [] });
  });
});
