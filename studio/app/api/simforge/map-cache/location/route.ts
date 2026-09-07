import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readLocalHostState } from "@simforge-oss/studio-host/node";
import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/**
 * `{ directory }` -> status. Only the desktop shell may call this: the path
 * comes from its native folder picker, so, like /host/shutdown, the request
 * must carry the per-start control token from `host.json`. A renderer never
 * gets to name a directory on this machine.
 */
export async function POST(request: Request) {
  const state = await readLocalHostState();
  if (!state) return NextResponse.json({ error: { name: "MapCacheError", message: "The local host state is missing" } }, { status: 409 });
  const presented = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(state.controlToken);
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    return NextResponse.json({ error: { name: "SecurityError", message: "Only the SimForge desktop shell can change the cache location" } }, { status: 401 });
  }
  try {
    const body = await readMapCacheBody(request);
    return mapCacheJson(await (await getMapCacheService()).setLocation(body.directory));
  } catch (error) {
    return mapCacheErrorResponse("location", error);
  }
}
