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

  it("once the video is removed only Reject is offered (a change can't be made any more)", () => {
    expect(buttons(render([clipCall], true))).toEqual(["Reject"]);
  });

  it("the snapping hint belongs to edits that include a clip", () => {
    expect(editHasClip([clipCall])).toBe(true);
    expect(editHasClip([selectionCall])).toBe(false);
    expect(editHasClip([{ ...clipCall, name: "trim_clip" }, selectionCall])).toBe(true);
  });
});
