import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isAuthorized } from "@/lib/auth";

/** Password gate: active only when APP_PASSWORD is set. Pages redirect to /login, API routes answer 401. */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  if (await isAuthorized(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // Exactly `api/sessions/upload` (anchored with `$`) is excluded on purpose: when middleware runs, Next buffers the request body in memory
  // (and truncates it past 10 MB), which would break streamed multi-GB uploads. That route checks the gate itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/sessions/upload$).*)"],
};
