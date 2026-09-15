import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  HostOrigin,
  InvalidOriginError,
  LOCAL_HOST_SESSION_COOKIE,
  LOCAL_HOST_TOKEN_ENV,
  hostPath,
  localHostSessionToken,
  secretsEqual,
  type HostPath,
} from "@simforge-oss/studio-host/node";

const tickets = new Map<string, { next: HostPath; expiresAt: number }>();
const SESSION_PATH = hostPath("/api/simforge/host/session");
const DEFAULT_NEXT = hostPath("/dashboard/scenario");
const TICKET_LIFETIME_MS = 60_000;

/**
 * A native caller exchanges its control token for a one-use browser ticket.
 * The control token never appears in a URL, browser history or referrer.
 * Electron sets the same session cookie directly and does not use this route.
 *
 * The ticket is minted against the authority the request arrived on, not the
 * server's own view of itself (`HostOrigin.fromReceivedRequest`): a host bound to a network
 * address reports `http://localhost:<port>`, so a caller on another machine
 * would otherwise be handed a URL only the host can resolve. That is also the
 * authority `studio/proxy.ts` compares `Origin` against for mutations, so the
 * session this ticket bootstraps can mutate on exactly the origin it was
 * minted for. `next` stays a same-origin relative path either way.
 */
export async function POST(request: Request) {
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!controlToken || !secretsEqual(bearer, controlToken)) {
    return NextResponse.json({ error: "host_control_unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || (body.next !== undefined && typeof body.next !== "string")) {
    return NextResponse.json({ error: "invalid_browser_target" }, { status: 400 });
  }
  let origin: HostOrigin;
  let next: HostPath;
  try {
    origin = HostOrigin.fromReceivedRequest(request);
    next = origin.relative(body.next === undefined ? DEFAULT_NEXT : hostPath(body.next));
  } catch (error) {
    if (!(error instanceof InvalidOriginError)) throw error;
    return NextResponse.json({ error: "invalid_browser_target" }, { status: 400 });
  }
  const now = Date.now();
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
  if (tickets.size >= 64) return NextResponse.json({ error: "browser_open_pending" }, { status: 429 });
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { next, expiresAt: now + TICKET_LIFETIME_MS });
  const url = origin.toURL(SESSION_PATH);
  url.searchParams.set("ticket", ticket);
  return NextResponse.json({ url: url.toString() }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  let origin: HostOrigin;
  try {
    origin = HostOrigin.fromReceivedRequest(request);
  } catch (error) {
    if (!(error instanceof InvalidOriginError)) throw error;
    return NextResponse.json({ error: "browser_ticket_invalid" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (!controlToken || !entry || entry.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "browser_ticket_invalid" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const response = NextResponse.redirect(origin.toURL(entry.next), { status: 303 });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.cookies.set({
    name: LOCAL_HOST_SESSION_COOKIE,
    value: localHostSessionToken(controlToken),
    httpOnly: true,
    sameSite: "strict",
    secure: origin.isSecure(),
    path: "/",
  });
  return response;
}
