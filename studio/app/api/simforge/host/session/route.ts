import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  LOCAL_HOST_SESSION_COOKIE,
  LOCAL_HOST_TOKEN_ENV,
  localHostSessionToken,
  secretsEqual,
} from "@simforge-oss/studio-host/node";

const tickets = new Map<string, { next: string; expiresAt: number }>();
const TICKET_LIFETIME_MS = 60_000;

/**
 * A native caller exchanges its control token for a one-use browser ticket.
 * The control token never appears in a URL, browser history or referrer.
 * Electron sets the same session cookie directly and does not use this route.
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
  const origin = new URL(request.url).origin;
  const next = body.next ?? "/dashboard/scenario";
  let destination: URL;
  try {
    destination = new URL(next, origin);
  } catch {
    return NextResponse.json({ error: "invalid_browser_target" }, { status: 400 });
  }
  if (!next.startsWith("/") || destination.origin !== origin) {
    return NextResponse.json({ error: "invalid_browser_target" }, { status: 400 });
  }
  const now = Date.now();
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
  if (tickets.size >= 64) return NextResponse.json({ error: "browser_open_pending" }, { status: 429 });
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { next: `${destination.pathname}${destination.search}${destination.hash}`, expiresAt: now + TICKET_LIFETIME_MS });
  const url = new URL("/api/simforge/host/session", origin);
  url.searchParams.set("ticket", ticket);
  return NextResponse.json({ url: url.toString() }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket") ?? "";
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!controlToken || !entry || entry.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "browser_ticket_invalid" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const response = NextResponse.redirect(new URL(entry.next, url.origin), { status: 303 });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.cookies.set({
    name: LOCAL_HOST_SESSION_COOKIE,
    value: localHostSessionToken(controlToken),
    httpOnly: true,
    sameSite: "strict",
    secure: url.protocol === "https:",
    path: "/",
  });
  return response;
}
