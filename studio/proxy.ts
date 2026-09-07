import { NextResponse, type NextRequest } from "next/server";
import {
  LOCAL_HOST_SESSION_COOKIE,
  LOCAL_HOST_TOKEN_ENV,
  localHostSessionToken,
  secretsEqual,
} from "@simforge-oss/studio-host/node";

/**
 * Local service access gate. Loopback is not authorization: any process or
 * page on this machine can open a TCP connection to the Studio host, so every
 * application request must prove it belongs to this installation, including
 * server-rendered pages and Server Actions, not only `/api/**`:
 *
 *   1. `Authorization: Bearer <control token>` — the per-start secret the
 *      supervisor generates and hands only to the processes it owns (the
 *      desktop shell reads it from the mode-0600 `host.json`, the CPU worker
 *      and this server receive it as `SIMFORGE_LOCAL_HOST_TOKEN`). Native
 *      processes use this form.
 *   2. The trusted-local session cookie — an HMAC of the control token that
 *      the desktop shell sets on its sandboxed renderer session (HttpOnly,
 *      SameSite=Strict) and `/api/simforge/host/session` sets for a browser
 *      bootstrapped with the token. Browsers use this form. Mutations must
 *      additionally arrive from the service's own origin (`Origin` or
 *      `Sec-Fetch-Site: same-origin`); a cross-site page can neither read the
 *      cookie (SameSite) nor forge the origin.
 *
 * `/api/simforge/cloud/callback` is exempt: the system browser reaches it
 * and it is protected by its own pending state + PKCE.
 * `/api/local-objects/**` validates its own expiring method/path/query
 * signature, so workers and downloads never need a general host token in URLs.
 * `/api/simforge/host/session` is exempt: it validates the token itself.
 *
 * Without a control token (the server was started bare, `next dev`, outside
 * the supervisor) the gate cannot verify anything and refuses application
 * traffic rather than degrading to an open loopback service.
 */

const EXEMPT_PATHS = new Set(["/api/simforge/cloud/callback", "/api/simforge/host/session"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function json(status: number, error: string, detail: string) {
  return NextResponse.json({ error, detail }, { status, headers: { "cache-control": "no-store", vary: "Authorization, Cookie" } });
}

export function proxy(request: NextRequest) {
  if (EXEMPT_PATHS.has(request.nextUrl.pathname) || request.nextUrl.pathname.startsWith("/api/local-objects/")) return NextResponse.next();
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  if (!controlToken) {
    return json(503, "host_unsupervised", "The Studio host is running without a supervisor control token; start it with `pnpm dev`, `pnpm start` or the desktop app.");
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer !== undefined) {
    if (secretsEqual(bearer, controlToken)) return NextResponse.next();
    // The CPU worker presents its own token, verified by the routes it calls
    // (authorizeScenarioWorker). The supervisor makes both tokens the same, so
    // a foreign bearer is simply unauthorized here.
    return json(401, "local_access_denied", "Invalid local host token.");
  }
  const session = request.cookies.get(LOCAL_HOST_SESSION_COOKIE)?.value;
  if (!secretsEqual(session, localHostSessionToken(controlToken))) {
    return json(401, "local_access_denied", "No trusted local session; open Studio through the desktop app or `pnpm host:open`.");
  }
  if (!READ_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    // NextURL normalizes loopback names to localhost. Browser Origin retains
    // the actual authority, so compare against the received Host header.
    const expected = new URL(request.nextUrl.href);
    expected.host = request.headers.get("host") ?? expected.host;
    const sameOrigin = origin !== null ? origin === expected.origin : site === "same-origin";
    if (!sameOrigin) return json(403, "local_origin_rejected", "Local mutations must come from the Studio origin.");
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static/|favicon.ico$|icon.svg$).*)"],
};
