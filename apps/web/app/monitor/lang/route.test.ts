import { describe, expect, it } from "vitest";
import { GET } from "./route";

const call = (qs: string) => GET(new Request(`http://localhost:3000/monitor/lang?${qs}`));

describe("GET /monitor/lang", () => {
  it("sets the language cookie and goes back to the monitor page", async () => {
    const res = await call(`to=pt-BR&back=${encodeURIComponent("/monitor/deputados/204407?q=a")}`);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/monitor/deputados/204407?q=a");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("monitor_lang=pt-BR");
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("never redirects off the monitor", async () => {
    for (const back of ["//evil.example", "https://evil.example", "/\\evil.example", "/login", "/monitorx", "javascript:alert(1)"]) {
      const res = await call(`to=en&back=${encodeURIComponent(back)}`);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.host).toBe("localhost:3000");
      expect(loc.pathname).toBe("/monitor");
    }
  });

  it("ignores an unknown language", async () => {
    const res = await call("to=xx&back=/monitor");
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
