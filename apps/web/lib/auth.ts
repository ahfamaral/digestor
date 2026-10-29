// Edge-safe (Web Crypto only): imported by middleware.ts as well as Node route handlers.
export const AUTH_COOKIE = "digestor_auth";
export const AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** HMAC-SHA256 keyed with APP_PASSWORD over "digestor", hex-encoded: the cookie value. */
export async function authToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("digestor")));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the gate is off (APP_PASSWORD unset) or the cookie carries the right token. */
export async function isAuthorized(cookieValue: string | undefined): Promise<boolean> {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await authToken(password));
}

/** Reads the auth cookie from a raw Cookie header (route handlers that run outside the middleware). */
export function authCookieFrom(req: Request): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === AUTH_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
