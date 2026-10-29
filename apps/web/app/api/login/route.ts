import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS, authToken } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

const LoginSchema = z.object({ password: z.string() });

export async function POST(req: Request): Promise<Response> {
  const parsed = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "Enter the password.");
  const expected = process.env.APP_PASSWORD;
  if (!expected) return NextResponse.json({ ok: true }); // gate is off
  if (parsed.data.password !== expected) return errorResponse(401, "Wrong password.");
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
