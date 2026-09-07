import { NextResponse } from "next/server";
import { readLocalHostState, secretsEqual } from "@simforge-oss/studio-host/node";
import { shutdownDatabase } from "@/app/lib/db/data-api";

/**
 * Ask the local supervisor to stop the Next server and the interactive
 * workers. Authorized by the per-start control token in `host.json` (the same
 * secret the access gate accepts), so only the desktop shell or
 * `pnpm host:stop` on this machine can call it.
 *
 * POSIX: SIGTERM the supervisor, which forwards it to the server and worker
 * so each drains at a safe boundary. Windows has no catchable signals —
 * `process.kill` there is TerminateProcess and would orphan the children — so
 * this server drains its own database and exits; the supervisor observes the
 * server exit, stops the worker and removes the host record.
 *
 * Durable jobs are not touched: the CPU render worker completes or releases
 * its lease and the native runner's detached jobs are owned by their own
 * supervisor, so closing the UI never kills them.
 */
export async function POST(request: Request) {
  const state = await readLocalHostState();
  if (!state) return NextResponse.json({ error: "host_state_missing" }, { status: 409 });
  const presented = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!secretsEqual(presented, state.controlToken)) {
    return NextResponse.json({ error: "host_control_unauthorized" }, { status: 401 });
  }
  if (process.platform === "win32") {
    setTimeout(() => {
      void shutdownDatabase().finally(() => process.exit(0));
    }, 100);
    return NextResponse.json({ ok: true, pid: state.pid });
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return NextResponse.json({ error: "host_supervisor_not_running", pid: state.pid }, { status: 409 });
  }
  return NextResponse.json({ ok: true, pid: state.pid });
}
