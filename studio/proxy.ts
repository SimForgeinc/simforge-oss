import { NextResponse, type NextRequest } from "next/server";
import {
  HostOrigin,
  InvalidOriginError,
  LOCAL_HOST_SESSION_COOKIE,
  LOCAL_HOST_TOKEN_ENV,
  localHostSessionToken,
  secretsEqual,
} from "@simforge-oss/studio-host/node";
import { isUnservedRoute } from "@/app/host/routes";

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
 * `/api/simforge/host/pair` is exempt for the same reason: a shell claiming a
 * pairing code has no credentials yet, and the minting half checks the bearer.
 *
 * When `SIMFORGE_LOCAL_OPEN_ACCESS=1`, the local daemon is intentionally
 * unauthenticated for a private LAN/tailnet development session. This is
 * explicit and opt-in; it bypasses only the host gate, not Cloud credentials.
 */

const EXEMPT_PATHS = new Set(["/api/simforge/cloud/callback", "/api/simforge/host/session", "/api/simforge/host/pair"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function json(status: number, error: string, detail: string) {
  return NextResponse.json({ error, detail }, { status, headers: { "cache-control": "no-store", vary: "Authorization, Cookie" } });
}

export function proxy(request: NextRequest) {
  // Routes this host does not serve answer like routes that were never
  // written. Empty on a local installation, which serves all of them.
  if (isUnservedRoute(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 });
  }
  if (process.env.SIMFORGE_LOCAL_OPEN_ACCESS === "1") return NextResponse.next();
  if (EXEMPT_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  if (!controlToken) {
    return json(503, "host_unsupervised", "The Studio host is running without a supervisor control token; start it with `simforge daemon`, `pnpm dev` or the desktop app.");
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
    return json(401, "local_access_denied", "No trusted local session; open Studio through the desktop app or `simforge host open`.");
  }
  if (!READ_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    // NextURL normalizes the bound interface (and loopback names) to
    // localhost. The browser Origin retains the authority it actually used,
    // so compare against the authority the request arrived on. A `Host` that
    // is not an authority cannot be the origin of anything and is rejected.
    let sameOrigin: boolean;
    try {
      sameOrigin = origin !== null ? HostOrigin.fromReceivedRequest(request).owns(origin) : site === "same-origin";
    } catch (error) {
      if (!(error instanceof InvalidOriginError)) throw error;
      sameOrigin = false;
    }
    if (!sameOrigin) return json(403, "local_origin_rejected", "Local mutations must come from the Studio origin.");
  }
  return NextResponse.next();
}

export const config = {
  // `/api/local-objects/**` is excluded from the matcher, not waved through
  // inside the handler. A matched request has its body buffered by the
  // framework before this function runs, capped at 10 MiB and TRUNCATED past
  // it, which silently cut render uploads short and surfaced as a checksum
  // mismatch. The route verifies its own expiring method/path/query signature
  // on every verb and streams the body itself, so excluding it removes a
  // buffer rather than a check.
  matcher: ["/((?!_next/static/|favicon.ico$|icon.svg$|api/local-objects/).*)"],
};
