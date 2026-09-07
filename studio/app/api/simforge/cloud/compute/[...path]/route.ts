import { connection, NextResponse } from "next/server";
import { cloudRequest } from "@/app/lib/cloud/connection";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * The installed app's authenticated window onto the SimCloud compute control
 * plane (`/api/simforge/compute/**`).
 *
 * The renderer holds no cloud credentials — the local service does — so the
 * shared evaluation UI talks to this prefix and the local service attaches the
 * bearer token. Nothing is interpreted here: the path, query, body and status
 * pass through so the desktop and the web portal are literally using one API,
 * and a contract change on the SimCloud side needs no edit in this file.
 *
 * Uploads are deliberately *not* proxied. Reserve/complete are control-plane
 * calls that come through here, but the bytes go straight from the renderer to
 * the storage grant, which is the whole point of an exact-object grant.
 */

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key"];
const WORKSPACE_HEADER = "x-simforge-workspace-id";

async function proxy(request: Request, path: string[]): Promise<Response> {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const suffix = path.map((segment) => encodeURIComponent(segment)).join("/");
  const query = new URL(request.url).search;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

  try {
    const response = await cloudRequest(
      `/api/simforge/compute/${suffix}${query}`,
      { method: request.method, headers, body },
      {
        workspaceId: request.headers.get(WORKSPACE_HEADER) ?? undefined,
        signal: request.signal,
      },
    );
    const payload = await response.text();
    return new NextResponse(payload.length > 0 ? payload : null, {
      status: response.status,
      headers: {
        ...SCENARIO_PRIVATE_CACHE_HEADERS,
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    return transferErrorResponse(error);
  }
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}
