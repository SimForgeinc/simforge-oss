import { NextResponse } from "next/server";
import { readJson, requireScenarioContext } from "@/app/lib/scenario/http";

const NO_STORE = { "cache-control": "no-store" };
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/** Server-only bridge to the pooled Python runtime. Questions, thresholds and
 * the API key stay in jevdrive; the browser never chooses a model or endpoint. */
async function forward(path: "contract" | "decision", body?: unknown) {
  const base = process.env.JEVDRIVE_URL ?? "http://127.0.0.1:8766";
  const target = new URL(`/${path}`, base);
  if (!LOOPBACK_HOSTS[target.hostname]) {
    return NextResponse.json({ error: "jev_service_must_be_loopback" }, { status: 503, headers: NO_STORE });
  }
  try {
    const response = await fetch(target, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    return NextResponse.json(await response.json(), { status: response.status, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "jev_service_unavailable", message: "Start the local jevdrive decision service before takeover." },
      { status: 503, headers: NO_STORE });
  }
}

export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return forward("contract");
}

export async function POST(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body || JSON.stringify(body).length > 100_000) {
    return NextResponse.json({ error: "invalid_scene" }, { status: 400, headers: NO_STORE });
  }
  return forward("decision", body);
}
