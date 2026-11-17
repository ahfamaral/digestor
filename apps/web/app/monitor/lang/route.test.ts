import { describe, expect, it } from "vitest";
import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost:3000/monitor/lang?${qs}`));

describe("GET /monitor/lang", () => {
  it("sets the language cookie and goes back to the monitor page", async () => {
    const res = await call(`to=pt-BR&back=${encodeURIComponent("/monitor/deputados/204407?q=a")}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/monitor/deputados/204407?q=a");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("monitor_lang=pt-BR");
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("never redirects off the monitor", async () => {
    for (const back of ["//evil.example", "https://evil.example", "/\\evil.example", "/login", "/monitorx", "javascript:alert(1)"]) {
      const res = await call(`to=en&back=${encodeURIComponent(back)}`);
      expect(res.headers.get("location")).toBe("/monitor");
    }
  });

  it("redirects with a path only, never the server's own address (behind the proxy that is 0.0.0.0:3000)", async () => {
    const res = await GET(new Request("http://0.0.0.0:3000/monitor/lang?to=en&back=%2Fmonitor%3Fq%3Dx"));
    expect(res.headers.get("location")).toBe("/monitor?q=x");
  });

  it("a back link the Location header can't carry (non-ASCII, a newline) never answers 500", async () => {
    const wide = await call(`to=en&back=${encodeURIComponent("/monitor?q=中国 — x")}`);
    expect(wide.status).toBe(303);
    expect(wide.headers.get("location")).toBe("/monitor?q=%E4%B8%AD%E5%9B%BD%20%E2%80%94%20x");
    const newline = await call(`to=en&back=${encodeURIComponent("/monitor/\nx")}`);
    expect(newline.status).toBe(303);
    expect(newline.headers.get("location")).toMatch(/^\/monitor/);
    expect(newline.headers.get("location")).not.toMatch(/[\r\n]/);
  });

  it("ignores an unknown language", async () => {
    const res = await call("to=xx&back=/monitor");
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
