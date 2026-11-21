import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AskAction } from "@digestor/core";
import { editHasClip } from "@/lib/askText";
import { ApprovalCard } from "./ApprovalCard";

const clipCall = { id: "c1", name: "propose_clip", args: { title: "Rent caps" }, summary: "Make a clip 00:00:10–00:00:30 'Rent caps'", range: { startMs: 10_000, endMs: 30_000 } };
const selectionCall = { id: "c2", name: "set_selection", args: {}, summary: "Approve 1 moment: 'A'", moments: [{ id: "m1", title: "A", startMs: 0, endMs: 1000 }] };
const card = (calls: unknown[]): AskAction => ({ id: "a1", messageId: "m", kind: "tool_approval", payload: { step: 1, calls }, status: "pending", resolution: null });
const render = (calls: unknown[], videoRemoved: boolean) =>
  renderToStaticMarkup(<ApprovalCard action={card(calls)} lang="pt" busy={false} error={undefined} videoRemoved={videoRemoved} onDecide={() => {}} />);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("ApprovalCard", () => {
  it("offers Approve, Edit and Reject with one line per change", () => {
    const html = render([clipCall, selectionCall], false);
    expect(html).toContain("Approve these 2 changes?");
    expect(html).toContain("Make a clip 00:00:10–00:00:30 &#x27;Rent caps&#x27;");
    expect(buttons(html)).toEqual(["Approve", "Edit", "Reject"]);
  });

  it("several changes are numbered (the Edit form's blocks are headed Change 1, Change 2…); one change is a plain line", () => {
    const html = render([clipCall, selectionCall], false);
    expect(html).toMatch(/<ol[^>]*list-decimal[^>]*><li[^>]*>Make a clip/);
    expect(html.match(/<li /g)).toHaveLength(2);
    const one = render([clipCall], false);
    expect(one).not.toContain("<ol");
    expect(one).toContain("Approve this change?");
    expect(one).toMatch(/<p[^>]*>Make a clip 00:00:10–00:00:30/);
  });

  it("once the video is removed only Reject is offered (a change can't be made any more)", () => {
    expect(buttons(render([clipCall], true))).toEqual(["Reject"]);
  });

  it("the snapping hint belongs to edits that include a clip", () => {
    expect(editHasClip([clipCall])).toBe(true);
    expect(editHasClip([selectionCall])).toBe(false);
    expect(editHasClip([{ ...clipCall, name: "trim_clip" }, selectionCall])).toBe(true);
  });
});

describe("ApprovalCard: stale", () => {
  it("a stale card says which clip changed instead of Declined", () => {
    const action: AskAction = { ...card([clipCall]), status: "dismissed", resolution: { decision: "reject", stale: [{ n: 2, removed: false }] } };
    const html = renderToStaticMarkup(<ApprovalCard action={action} lang="en" busy={false} error={undefined} videoRemoved={false} onDecide={() => {}} />);
    expect(html).toContain("Clip 2 changed since this card was made. Ask again.");
    expect(html).not.toContain("Declined.");
    expect(buttons(html)).toEqual([]);
  });
});

describe("ApprovalCard: clip package (C3)", () => {
  const pkg = {
    id: "pkg", name: "make_clip_package", args: {}, summary: "Make 3 clips (9:16) with English subtitle drafts: …",
    package: {
      clips: [
        { startMs: 60_000, endMs: 90_000, title: "Ajuda à Ucrânia" },
        { startMs: 180_000, endMs: 220_000, title: "Two" },
        { startMs: 300_000, endMs: 330_000, title: "Three" },
      ],
      format: "9:16", subtitles: "en",
    },
  };

  it("is the pick: a ticked checkbox per clip, the format, the subtitle language, then Make 3 clips or Reject", () => {
    const html = render([pkg], false);
    expect(html).toContain("Make these clips?");
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(html).toContain("00:01:00–00:01:30");
    expect(html).toContain("Ajuda à Ucrânia");
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*value="9:16"|<input[^>]*type="radio"[^>]*value="9:16"[^>]*checked=""/);
    expect(html).toMatch(/<option value="en" selected="">English<\/option>/);
    expect(buttons(html)).toContain("Make 3 clips");
    expect(buttons(html)).toContain("Reject");
    expect(buttons(html)).toContain("Edit times and titles");
  });

  it("each offered clip is its own labelled group (Clip 1, Clip 2…), so its fields stay together when editing", () => {
    const html = render([pkg], false);
    expect(html).toContain('role="group" aria-label="Clip 1"');
    expect(html).toContain('role="group" aria-label="Clip 3"');
  });

  it("states the estimated cost before Make: translating the drafts (100 s of clips into English from Portuguese)", () => {
    expect(render([pkg], false)).toContain("Estimated cost: under $0.01 for translating the subtitles. Making the videos runs on this server and costs nothing.");
    expect(render([{ ...pkg, package: { ...pkg.package, subtitles: null } }], false)).toContain("No AI cost: making the videos runs on this server.");
    expect(render([{ ...pkg, package: { ...pkg.package, subtitles: "pt" } }], false)).toContain("No AI cost: making the videos runs on this server.");
  });

  it("once the video is removed only Reject is offered", () => {
    const html = render([pkg], true);
    expect(buttons(html)).toContain("Reject");
    expect(buttons(html).some((b) => b.startsWith("Make"))).toBe(false);
  });

  it("decided: says how many clips are being made, with a link to Prepare", () => {
    const action: AskAction = { ...card([pkg]), status: "confirmed", resolution: { decision: "edit", edits: [{ id: "pkg", args: { clips: [{}, {}], format: "9:16", subtitles: "de" } }] } };
    const html = renderToStaticMarkup(<ApprovalCard action={action} sessionId="s1" lang="pt" busy={false} error={undefined} videoRemoved={false} onDecide={() => {}} />);
    expect(html).toContain("2 clips are being made (9:16, German subtitle drafts).");
    expect(html).toContain('href="/s/s1/prepare"');
    expect(html).not.toContain("role=\"checkbox\"");
  });
});

describe("ApprovalCard: clip package, fix round (C3)", () => {
  const pkg = {
    id: "pkg", name: "make_clip_package", args: {}, summary: "Make 2 clips (9:16): …",
    package: { clips: [{ startMs: 60_000, endMs: 90_000, title: "One" }, { startMs: 180_000, endMs: 220_000, title: "Two" }], format: "9:16", subtitles: null },
  };
  const decided = (outcome: { ok: boolean; made: number } | null) =>
    renderToStaticMarkup(
      <ApprovalCard action={{ ...card([pkg]), status: "confirmed", resolution: { decision: "approve" } }} outcome={outcome} sessionId="s1" lang="pt" busy={false} error={undefined} videoRemoved={false} onDecide={() => {}} />,
    );

  it("the decided line follows the tool's record: made, failed, or failed partway", () => {
    expect(decided({ ok: true, made: 2 })).toContain("2 clips are being made (9:16).");
    expect(decided({ ok: false, made: 0 })).toContain("No clips were made.");
    expect(decided({ ok: false, made: 0 })).not.toContain("being made");
    expect(decided({ ok: false, made: 1 })).toContain("Only 1 of the clips was made before something went wrong.");
    expect(decided(null)).toContain("2 clips are being made (9:16).");
  });
});
