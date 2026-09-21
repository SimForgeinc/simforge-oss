import { NextResponse } from "next/server";
import {
  STUDIO_HOST_PROTOCOL_VERSION,
  STUDIO_HOST_TRANSPORTS,
} from "@simforge-oss/studio-host";
import { SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";

/**
 * The protocol handshake for workers. A worker holds the worker bearer and no
 * account session, so it cannot read `/api/simforge/host/capabilities`; what
 * it needs before claiming is only the host's protocol version, and that is
 * the same on every host kind. Same `checkHostProtocolVersion` on the client.
 */
export async function GET(request: Request) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json(
    { protocolVersion: STUDIO_HOST_PROTOCOL_VERSION, transports: STUDIO_HOST_TRANSPORTS },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
