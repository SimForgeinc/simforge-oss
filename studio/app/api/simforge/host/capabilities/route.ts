import { NextResponse } from "next/server";
import { getLocalHostCapabilities } from "@/app/lib/host/capabilities";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * What this host can do right now: identity mode, persistence, registered
 * render workers, and whether the native runner is installed. Also the local
 * readiness probe the desktop shell and supervisor wait on, and the protocol
 * handshake: `protocolVersion`/`transports` are what every client (desktop
 * shell, CLI, worker) checks with `checkHostProtocolVersion` before it loads a
 * page or issues a call, so an incompatible host is refused up front.
 */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const capabilities = await getLocalHostCapabilities(auth.context);
  return NextResponse.json(capabilities, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
