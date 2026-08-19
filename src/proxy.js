/**
 * src/proxy.js
 *
 * Next.js 16 route proxy (formerly middleware.js — renamed in v16).
 * Export name is `proxy`, NOT `middleware`.
 *
 * Responsibility: coarse redirect — unauthenticated users hitting /dashboard
 * get redirected to /login with the original URL as callbackUrl.
 *
 * IMPORTANT: This is a first line of defense, NOT the only one.
 * Every Server Action and Server Component that handles privileged data
 * re-checks the session independently (auth() call). The proxy docs
 * explicitly warn not to rely on proxy alone for auth.
 *
 * Routes affected: /dashboard and everything under it.
 * Routes unaffected: /, /login, /api/auth/*, /api/webhooks/*, static assets.
 */

import { auth } from "@/auth";
import { NextResponse } from "next/server";

export async function proxy(request) {
  const session = await auth();
  const { pathname } = request.nextUrl;

  // Redirect unauthenticated requests to /login with the original URL as callbackUrl.
  if (pathname.startsWith("/dashboard") && !session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // All other paths pass through.
  return NextResponse.next();
}

/**
 * Matcher: only run the proxy on /dashboard paths.
 * /api/*, /login, /, static assets are intentionally excluded.
 */
export const config = {
  matcher: ["/dashboard/:path*"],
};
