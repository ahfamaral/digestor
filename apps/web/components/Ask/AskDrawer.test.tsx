import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

import { AskDrawer, askTakesFocus } from "./AskDrawer";

const render = (open: boolean) =>
  renderToStaticMarkup(<AskDrawer sessionId="s1" language="en" hasVideo videoRemoved={false} examples={[]} open={open} onOpenChange={() => {}} />);

describe("AskDrawer", () => {
  it("renders its trigger button with the / hint, closed or open", () => {
    expect(render(false)).toContain("aria-keyshortcuts=\"/\"");
    expect(render(true)).toContain("aria-keyshortcuts=\"/\"");
  });

  it("an automatic open leaves focus on the page; the journalist's open focuses the question box", () => {
    expect(askTakesFocus(true)).toBe(false);
    expect(askTakesFocus(false)).toBe(true);
  });
});
