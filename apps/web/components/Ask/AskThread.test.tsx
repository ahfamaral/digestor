import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

import { AskThread, type AskThreadMessage } from "./AskThread";

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

  it("a package gets one titled link per clip", () => {
    const html = render([userQ("u1", "3 clips"), answerWith("a1", "Made.", [{ name: "make_clip_package", args: { clips: [{ title: "One" }, { title: "Two" }] }, result: "ok", ok: true, clipIds: ["a", "b"] }])]);
    expect(html).toContain('href="/s/s1/prepare#clip-a"');
    expect(html).toContain("Open in Prepare: One");
    expect(html).toContain("Open in Prepare: Two");
  });

  it("AskThread renders in the drawer: the input, the examples on an empty thread", () => {
    const html = render([]);
    expect(html).toContain('id="ask-input"');
    expect(html).toContain("What were the main topics?");
  });
});
