import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

import { AskThread, archivedConversations, type AskThreadMessage } from "./AskThread";

const base = { sessionId: "s1", ownerId: "owner", status: "done", actions: [], createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:01.000Z" };
const userQ = (id: string, text: string): AskThreadMessage => ({ ...base, id, role: "user", text, toolCalls: null }) as AskThreadMessage;
const answerWith = (id: string, text: string, toolCalls: unknown): AskThreadMessage => ({ ...base, id, role: "assistant", text, toolCalls }) as AskThreadMessage;
const askUser = (id: string, options: string[]) => answerWith(id, "Which platform?", [{ name: "ask_user", args: { question: "Which platform?", options }, result: "Which platform?", ok: true }]);

const render = (messages: AskThreadMessage[], extra: Partial<Parameters<typeof AskThread>[0]> = {}) =>
  renderToStaticMarkup(<AskThread sessionId="s1" language="en" hasVideo videoRemoved={false} examples={["What were the main topics?"]} active initialMessages={messages} {...extra} />);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("AskThread", () => {
  it("ask_user rendered as options: the last answer's options are buttons", () => {
    const html = render([userQ("u1", "A clip on rents"), askUser("a1", ["Instagram / TikTok (9:16)", "X / YouTube (16:9)"])]);
    expect(buttons(html)).toEqual(expect.arrayContaining(["Instagram / TikTok (9:16)", "X / YouTube (16:9)"]));
    expect(html).toContain('aria-label="Quick answers"');
  });

  it("only the last answer's options are buttons", () => {
    const html = render([userQ("u1", "A clip"), askUser("a1", ["Old one", "Old two"]), userQ("u2", "Old one"), answerWith("a2", "Done.", [])]);
    expect(buttons(html)).not.toContain("Old one");
    expect(html).toContain("Old one");
    expect(html).not.toContain('aria-label="Quick answers"');
  });

  it("a clip change links to its card in Prepare", () => {
    const html = render([userQ("u1", "Clip it"), answerWith("a1", "Made it.", [{ name: "propose_clip", args: { title: "Rent caps" }, result: "Created", ok: true, clipId: "c-9" }])]);
    expect(html).toContain('href="/s/s1/prepare#clip-c-9"');
    expect(html).toContain("Open in Prepare");
  });

  it("never shows the tool's note to the model", () => {
    const note = "Clip 34989e73-8171-4ee6-9200-f490e4426469 updated. Burn-in stays with the user on Prepare.";
    const html = render([userQ("u1", "Add English"), answerWith("a1", "Added.", [{ name: "update_clip", args: { clipId: "c-9" }, result: note, ok: true, clipId: "c-9" }])]);
    expect(html).not.toContain("34989e73");
    expect(html).not.toContain("the user");
  });

  it("a package gets one titled link per clip", () => {
    const html = render([userQ("u1", "3 clips"), answerWith("a1", "Made.", [{ name: "make_clip_package", args: { clips: [{ title: "One" }, { title: "Two" }] }, result: "ok", ok: true, clipIds: ["a", "b"] }])]);
    expect(html).toContain('href="/s/s1/prepare#clip-a"');
    expect(html).toContain("Open in Prepare: One");
    expect(html).toContain("Open in Prepare: Two");
  });

  it("New conversation: shown once there is a conversation, greyed out while an answer is open", () => {
    expect(buttons(render([]))).not.toContain("New conversation");
    const done = render([userQ("u1", "Topics?"), answerWith("a1", "Housing.", [])]);
    expect(done).toMatch(/<button[^>]*>(?:(?!<\/button>).)*New conversation<\/button>/);
    expect(done).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*New conversation/);
    const open = render([userQ("u1", "Topics?"), { ...answerWith("a1", "", []), status: "pending" } as AskThreadMessage]);
    // Not disabled (a disabled button gets no hover or focus, so no balloon): marked aria-disabled, with the reason attached.
    expect(open).toMatch(/<button[^>]*aria-disabled="true"[^>]*>(?:(?!<\/button>).)*New conversation/);
    expect(open).toContain('id="ask-new-blocked"');
    expect(open).toContain("Finish the open answer or card first");
  });

  it("an archived conversation is not the current one: the drawer starts empty with a link to it", () => {
    const at = "2026-11-23T15:10:00.000Z";
    const old = [{ ...userQ("u1", "Old question"), archivedAt: at }, { ...answerWith("a1", "Old answer.", [{ name: "propose_clip", args: { title: "x" }, result: "ok", ok: true, clipId: "c-1" }]), archivedAt: at }] as AskThreadMessage[];
    const html = render(old);
    expect(html).toContain("Nothing asked yet");
    expect(html).toContain("Earlier conversations (1)");
    expect(html).not.toContain("Old question");
    expect(buttons(html)).not.toContain("New conversation");
  });

  it("archivedConversations groups by archive time, oldest first", () => {
    const m = (id: string, archivedAt: string | null) => ({ id, archivedAt });
    const groups = archivedConversations([m("1", "2026-11-23T10:00:00.000Z"), m("2", "2026-11-23T10:00:00.000Z"), m("3", "2026-11-22T09:00:00.000Z"), m("4", null)]);
    expect(groups.map((g) => [g.archivedAt, g.messages.map((x) => x.id)])).toEqual([
      ["2026-11-22T09:00:00.000Z", ["3"]],
      ["2026-11-23T10:00:00.000Z", ["1", "2"]],
    ]);
  });

  it("AskThread renders in the drawer: the input, the examples on an empty thread", () => {
    const html = render([]);
    expect(html).toContain('id="ask-input"');
    expect(html).toContain("What were the main topics?");
  });
});
