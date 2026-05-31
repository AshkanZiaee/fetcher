import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authToken } from "./lib/auth";

/**
 * Locks the ENTIRE app behind the password gate. Runs on every request except
 * Next internals, the login page, and the auth API. Unauthenticated requests
 * get a redirect to /login (pages) or a 401 (API) — so nothing is reachable
 * without logging in.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth).*)"],
};

export function middleware(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === authToken()) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}
