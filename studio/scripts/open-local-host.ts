import { spawn } from "node:child_process";
import { readLocalHostState } from "@simforge-oss/studio-host/node";

/**
 * Open the running local host in the default browser with a trusted-local
 * session: the desktop app sets its session cookie itself, a plain browser
 * uses a one-use ticket from `/api/simforge/host/session`. The per-start
 * control token is sent only in an authorization header, never in a URL.
 */
const state = await readLocalHostState();
if (!state) {
  process.stderr.write("No local host record found; start the host with `pnpm dev` or `pnpm start`.\n");
  process.exit(1);
}
const response = await fetch(new URL("/api/simforge/host/session", state.baseUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${state.controlToken}`, "content-type": "application/json" },
  body: JSON.stringify({ next: process.argv[2] ?? "/dashboard/scenario" }),
});
if (!response.ok) throw new Error(`Could not open a trusted browser session: HTTP ${response.status}`);
const body = await response.json() as { url: string };
const target = new URL(body.url);
if (target.origin !== new URL(state.baseUrl).origin) throw new Error("Host returned a foreign browser bootstrap URL");
const opener = process.platform === "darwin"
  ? { command: "open", args: [target.href] }
  : process.platform === "win32"
    ? { command: "cmd", args: ["/c", "start", "", target.href.replace(/&/g, "^&")] }
    : { command: "xdg-open", args: [target.href] };
const child = spawn(opener.command, opener.args, { stdio: "ignore", detached: true });
child.once("error", (error) => {
  process.stderr.write(`Could not open a browser (${error.message}); open this URL yourself:\n${target.href}\n`);
});
child.once("spawn", () => {
  child.unref();
  process.stdout.write(`Opening ${state.baseUrl} with a trusted local session.\n`);
});
