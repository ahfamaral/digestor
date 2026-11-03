import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS, authToken } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { clearWrong, clientIp, isThrottled, recordWrong } from "@/lib/loginThrottle";

const LoginSchema = z.object({ password: z.string() });

/** Constant-time comparison: both sides are hashed so the buffers have equal length. */
function samePassword(given: string, expected: string): boolean {
  const sha = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(sha(given), sha(expected));
}

export async function POST(req: Request): Promise<Response> {
  const parsed = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "Enter the password.");
  const expected = process.env.APP_PASSWORD;
  if (!expected) return NextResponse.json({ ok: true }); // gate is off
  const ip = clientIp(req);
  if (isThrottled(ip)) return errorResponse(429, "Too many attempts. Try again in a few minutes.");
  if (!samePassword(parsed.data.password, expected)) {
    recordWrong(ip);
    return errorResponse(401, "Wrong password.");
  }
  clearWrong(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await authToken(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: "/",
  });
  return res;
}
