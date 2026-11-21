import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/s/s1/prepare" }));

vi.mock("next/font/google", () => ({ Noto_Sans: () => ({ className: "", style: {}, variable: "" }) }));

import { PrepareList } from "./PrepareList";

describe("PrepareList", () => {
  it("AskThread renders on Prepare: the Ask button with its / shortcut is in the header", () => {
    const html = renderToStaticMarkup(
      <PrepareList
        session={{ id: "s1", title: "A video", language: "en", durationMs: 60_000, hasVideo: true, videoRemoved: false, profile: "interview", goal: null }}
        defaultCredit=""
        names={{ persons: [], attributions: [] } as never}
        whoRows={[]}
        clips={[]}
      />,
    );
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toContain(">Ask<");
  });
});
