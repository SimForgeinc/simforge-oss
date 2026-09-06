import { readLocalHostState } from "@simforge-oss/studio-host/node";

/** Stop the running local host through its authorized shutdown route. */
const state = await readLocalHostState();
if (!state) {
  process.stderr.write("No local host record found; nothing to stop.\n");
  process.exit(1);
}
const response = await fetch(`${state.baseUrl}/api/simforge/host/shutdown`, {
  method: "POST",
  headers: { authorization: `Bearer ${state.controlToken}` },
}).catch(() => null);
if (!response?.ok) {
  process.stderr.write(`Shutdown request failed (${response?.status ?? "unreachable"}); supervisor pid ${state.pid}.\n`);
  process.exit(1);
}
process.stdout.write(`Stopping local host pid ${state.pid}.\n`);
