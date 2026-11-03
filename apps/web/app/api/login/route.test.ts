import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLoginThrottleForTests } from "@/lib/loginThrottle";
import { POST } from "./route";

function login(password: string, ip?: string) {
  return POST(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
      body: JSON.stringify({ password }),
    }),
  );
}

beforeEach(() => {
  process.env.APP_PASSWORD = "hunter2";
  resetLoginThrottleForTests();
});
afterEach(() => {
  delete process.env.APP_PASSWORD;
});

describe("POST /api/login", () => {
  it("accepts the right password and sets the cookie, rejects a wrong one", async () => {
    const ok = await login("hunter2", "1.1.1.1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("digestor_auth=");
    const bad = await login("hunter3", "1.1.1.1");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "Wrong password." });
    expect((await login("hunter22", "1.1.1.1")).status).toBe(401); // different length
    expect((await login("", "1.1.1.1")).status).toBe(401);
  });

  it("answers 429 after 5 wrong attempts from one address, even for the right password, until the window passes", async () => {
    let now = 1_000_000;
    resetLoginThrottleForTests(() => now);
    for (let i = 0; i < 5; i++) expect((await login("nope", "2.2.2.2, 10.0.0.1")).status).toBe(401);
    const blocked = await login("hunter2", "2.2.2.2");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many attempts. Try again in a few minutes." });
    expect((await login("hunter2", "3.3.3.3")).status).toBe(200); // another address is not affected
    now += 10 * 60_000 + 1;
    expect((await login("hunter2", "2.2.2.2")).status).toBe(200);
  });

  it("a right password clears the count", async () => {
    for (let i = 0; i < 4; i++) await login("nope", "4.4.4.4");
    expect((await login("hunter2", "4.4.4.4")).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login("nope", "4.4.4.4")).status).toBe(401);
  });

  it("counts requests without a forwarded address together as 'unknown'", async () => {
    for (let i = 0; i < 5; i++) await login("nope");
    expect((await login("hunter2")).status).toBe(429);
  });
});
