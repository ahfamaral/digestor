import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { AUTH_COOKIE, authToken } from "@/lib/auth";
import { config, middleware } from "./middleware";

afterEach(() => {
  delete process.env.APP_PASSWORD;
});

function req(pathname: string, cookie?: string) {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: cookie ? { cookie: `${AUTH_COOKIE}=${cookie}` } : {},
  });
}

const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("password gate", () => {
  it("gate is off when APP_PASSWORD is unset", async () => {
    expect(passedThrough(await middleware(req("/api/sessions/youtube")))).toBe(true);
    expect(passedThrough(await middleware(req("/")))).toBe(true);
  });

  it("gate blocks API without cookie when APP_PASSWORD is set", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const res = await middleware(req("/api/files/x/proxy.mp4"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized." });
    const wrong = await middleware(req("/api/files/x/proxy.mp4", "deadbeef"));
    expect(wrong.status).toBe(401);
  });

  it("redirects pages to /login and lets the login routes through", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const page = await middleware(req("/s/abc"));
    expect(page.status).toBe(307);
    expect(page.headers.get("Location")).toBe("http://localhost/login");
    expect(passedThrough(await middleware(req("/login")))).toBe(true);
    expect(passedThrough(await middleware(req("/api/login")))).toBe(true);
  });

  it("accepts the HMAC cookie", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const token = await authToken("hunter2");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(passedThrough(await middleware(req("/", token)))).toBe(true);
    expect(passedThrough(await middleware(req("/api/sessions/youtube", token)))).toBe(true);
  });

  it("matcher skips static assets and the streamed upload route", () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test("/")).toBe(true);
    expect(re.test("/api/files/x/proxy.mp4")).toBe(true);
    expect(re.test("/_next/static/chunk.js")).toBe(false);
    expect(re.test("/_next/image")).toBe(false);
    expect(re.test("/favicon.ico")).toBe(false);
    expect(re.test("/api/sessions/upload")).toBe(false);
    // Only the exact upload route is excluded: anything below or beside it is still gated.
    expect(re.test("/api/sessions/upload/x")).toBe(true);
    expect(re.test("/api/sessions/uploads")).toBe(true);
  });
});

describe("POST /api/login", () => {
  function post(password: unknown) {
    return login(
      new Request("http://localhost/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    );
  }

  it("sets the auth cookie on the right password", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const res = await post("hunter2");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${AUTH_COOKIE}=${await authToken("hunter2")}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i); // only in production
  });

  it("answers 401 on a wrong password", async () => {
    process.env.APP_PASSWORD = "hunter2";
    const res = await post("nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Wrong password." });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
