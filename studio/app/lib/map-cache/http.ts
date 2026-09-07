// Error shaping shared by the /api/simforge/map-cache/** route handlers: the
// desktop bridge and other local callers read `{ error: { name, message } }`
// and rethrow it under that name (AbortError, NotAuthorized, ...).

import { NextResponse } from "next/server";

import { MapCacheError } from "./store";

const STATUS_BY_ERROR_NAME: Record<string, number> = {
  NotAuthorized: 403,
  NotFound: 404,
  AbortError: 499,
  QuotaExceededError: 507,
  IntegrityError: 502,
  NetworkError: 502,
  MapCacheError: 400,
};

export function mapCacheErrorResponse(operation: string, error: unknown) {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const status = STATUS_BY_ERROR_NAME[name] ?? 500;
  // Access-policy errors are written for the user like MapCacheError is; anything
  // else is an internal fault whose details stay in the host log.
  const userFacing = error instanceof MapCacheError || status !== 500;
  if (!userFacing) console.error(`[map-cache] ${operation} failed:`, error);
  const message = userFacing && error instanceof Error ? error.message : `Map cache ${operation} failed`;
  return NextResponse.json({ error: { name, message } }, { status, headers: { "cache-control": "no-store" } });
}

export function mapCacheJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function readMapCacheBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new MapCacheError("A JSON object body is required");
  return body as Record<string, unknown>;
}
