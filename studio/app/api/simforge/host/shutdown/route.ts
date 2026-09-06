import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readLocalHostState } from "@simforge-oss/studio-host/node";
import { requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

/**
 * Ask the local supervisor to stop the Next server and the interactive
 * workers. Authorized by the per-start control token in `host.json`, so only
 * the desktop shell or `pnpm host:stop` on this machine can call it.
 *
 * Durable jobs are not touched: the CPU render worker completes or releases
 * its lease and the native runner's detached jobs are owned by their own
 * supervisor, so closing the UI never kills them.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const state = await readLocalHostState();
  if (!state) return NextResponse.json({ error: "host_state_missing" }, { status: 409 });
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = Buffer.from(state.controlToken);
  const actual = Buffer.from(presented);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "host_control_unauthorized" }, { status: 401 });
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return NextResponse.json({ error: "host_supervisor_not_running", pid: state.pid }, { status: 409 });
  }
  return NextResponse.json({ ok: true, pid: state.pid });
}
