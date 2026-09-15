// The desktop shell attached to a Studio host on ANOTHER machine.
//
// The default shell owns its host: it starts (or adopts) a supervisor on this
// computer's filesystem and loads it from loopback. Remote-host mode is the
// explicit opt-in for the split deployment — daemon, Next server, database,
// render worker and GPU on one box, the window on another:
//
//   SIMFORGE_REMOTE_HOST=http://100.72.252.40:5421   the host's origin
//   SIMFORGE_REMOTE_HOST_TOKEN=<controlToken>        from that box's host.json
//   SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT=1           see below
//
// In this mode the shell never starts, supervises or stops a host: it is a
// guest. Quitting the window leaves the host running, which is the same
// contract the local shell already honours for a host it merely attached to.
//
// Credentials on the wire: the control token is sent as a bearer header and
// the derived trusted-local session cookie is set for the remote origin. Over
// plain HTTP both cross the network in cleartext, so a non-loopback `http://`
// target is refused unless the operator acknowledges it with
// SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT=1 — the acknowledgement that the link
// is a private tailnet (WireGuard/Tailscale) rather than an open network.
// `simforge host open` refuses a non-loopback bootstrap URL for the same
// reason; this is that rule with an operator-visible escape, not without one.

import { localHostSessionToken, waitForLocalHostReady } from "@simforge-oss/studio-host/node";
import { checkContract } from "./host-contract.mjs";

export const REMOTE_HOST_ENV = "SIMFORGE_REMOTE_HOST";
export const REMOTE_HOST_TOKEN_ENV = "SIMFORGE_REMOTE_HOST_TOKEN";
export const REMOTE_HOST_PLAINTEXT_ENV = "SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The remote host this shell was pointed at, or null for the normal local
 * shell. Throws when the configuration is present but unusable, so a
 * misconfigured launch fails loudly instead of silently starting a second
 * local host beside the remote one the operator meant to use.
 * @param {Record<string, string | undefined>} env
 * @returns {{ baseUrl: string; controlToken: string } | null}
 */
export function remoteHostTarget(env) {
  const configured = env[REMOTE_HOST_ENV]?.trim();
  if (!configured) return null;
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${REMOTE_HOST_ENV} must be the Studio host's base URL, for example http://100.72.252.40:5421 — got ${configured}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${REMOTE_HOST_ENV} must be an http:// or https:// URL — got ${configured}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${REMOTE_HOST_ENV} must be a bare origin with no path, query or fragment — got ${configured}`);
  }
  const controlToken = env[REMOTE_HOST_TOKEN_ENV]?.trim();
  if (!controlToken) {
    throw new Error(`${REMOTE_HOST_ENV} is set, so ${REMOTE_HOST_TOKEN_ENV} must carry that host's control token (the "controlToken" field of host.json in the host's data root).`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname) && env[REMOTE_HOST_PLAINTEXT_ENV] !== "1") {
    throw new Error(
      `${configured} is plain HTTP on a network address. The control token and the session cookie would cross the network in cleartext. `
      + `Put the host behind HTTPS, or reach it over a private tailnet (WireGuard/Tailscale) and acknowledge that with ${REMOTE_HOST_PLAINTEXT_ENV}=1.`,
    );
  }
  return { baseUrl: url.origin, controlToken };
}

/**
 * A host this shell is a guest of. Same shape as `createLocalHost`, minus
 * every notion of ownership: `dataRoot` is null because the data lives on the
 * host's filesystem, `owned()` is always false, and `stop()` does nothing.
 * @param {{ baseUrl: string; controlToken: string }} target
 */
export function createRemoteHost({ baseUrl, controlToken }) {
  return {
    /** Null: the database, artifacts and map cache are on the host's filesystem. */
    dataRoot: null,
    owned: () => false,
    /** Headers native calls from this process present to the remote service. */
    authorization: async () => ({ authorization: `Bearer ${controlToken}` }),
    /** The cookie value the renderer session carries; never the token itself. */
    sessionToken: () => localHostSessionToken(controlToken),
    async start() {
      const ready = await waitForLocalHostReady(baseUrl, {
        timeoutMs: 20_000,
        headers: { authorization: `Bearer ${controlToken}` },
      });
      if (!ready) {
        throw new Error(`No SimForge Studio host answered at ${baseUrl}. Start it there with \`simforge daemon --port <port>\` bound to a network address (HOSTNAME=0.0.0.0), and check that ${REMOTE_HOST_TOKEN_ENV} is that host's current control token.`);
      }
      const contract = await checkContract(baseUrl, controlToken);
      if (!contract.ok) {
        throw new Error(`The Studio host at ${baseUrl} is not this application's: ${contract.reason}. Run the same Studio version on both machines.`);
      }
      return { baseUrl, owned: false };
    },
    async stop() {},
  };
}
