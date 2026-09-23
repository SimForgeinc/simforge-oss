// The desktop shell attached to a Studio host on ANOTHER machine.
//
// The default shell owns its host: it starts (or adopts) a supervisor on this
// computer's filesystem and loads it from loopback. Remote-host mode is the
// explicit opt-in for the split deployment — daemon, Next server, database,
// render worker and GPU on one box, the window on another. The user reaches
// it from the connection chooser (desktop/connections-window.mjs), which
// remembers paired hosts and keeps their tokens in the OS vault; an operator
// or a script reaches it with three environment variables, which name one
// target for this launch and remember nothing:
//
//   SIMFORGE_REMOTE_HOST=http://100.64.0.10:5421   the host's origin
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
// target is refused unless the operator acknowledges it — the variable here,
// the ticked acknowledgement in the chooser — that the link is a private
// tailnet (WireGuard/Tailscale) rather than an open network. `simforge host
// open` refuses a non-loopback bootstrap URL for the same reason; this is
// that rule with an operator-visible escape, not without one.
import { localHostSessionToken, waitForLocalHostReady } from "@simforge-oss/studio-host/node";
import { parseHostOrigin, plaintextRefusal } from "./connections.mjs";
import { checkContract } from "./host-contract.mjs";

export const REMOTE_HOST_ENV = "SIMFORGE_REMOTE_HOST";
export const REMOTE_HOST_TOKEN_ENV = "SIMFORGE_REMOTE_HOST_TOKEN";
export const REMOTE_HOST_PLAINTEXT_ENV = "SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT";

/**
 * The remote host this launch was pointed at by environment, or null. Throws
 * when the configuration is present but unusable, so a misconfigured launch
 * fails loudly instead of silently starting a second local host beside the
 * remote one the operator meant to use.
 * @param {Record<string, string | undefined>} env
 * @returns {{ baseUrl: string; controlToken: string } | null}
 */
export function remoteHostTarget(env) {
  const configured = env[REMOTE_HOST_ENV]?.trim();
  if (!configured) return null;
  let parsed;
  try {
    parsed = parseHostOrigin(configured);
  } catch (error) {
    throw new Error(`${REMOTE_HOST_ENV}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const controlToken = env[REMOTE_HOST_TOKEN_ENV]?.trim();
  if (!controlToken) {
    throw new Error(`${REMOTE_HOST_ENV} is set, so ${REMOTE_HOST_TOKEN_ENV} must carry that host's control token (the "controlToken" in host.json under the host's data root).`);
  }
  if (parsed.plaintextNetwork && env[REMOTE_HOST_PLAINTEXT_ENV] !== "1") {
    throw new Error(plaintextRefusal(parsed.origin, `with ${REMOTE_HOST_PLAINTEXT_ENV}=1`));
  }
  return { baseUrl: parsed.origin, controlToken };
}

/**
 * A host this shell is a guest of. Same shape as `createLocalHost`, minus
 * every notion of ownership: `dataRoot` is null because the data lives on the
 * host's filesystem, `owned()` is always false, and `stop()` does nothing.
 * `probe()` is what the lost-connection watch calls: a remote daemon that
 * stops answering has no exit code to report, only an origin.
 * @param {{ baseUrl: string; controlToken: string }} target
 */
export function createRemoteHost({ baseUrl, controlToken }) {
  const headers = { authorization: `Bearer ${controlToken}` };
  return {
    /** Null: the database, artifacts and map cache are on the host's filesystem. */
    dataRoot: null,
    owned: () => false,
    /** Headers native calls from this process present to the remote service. */
    authorization: async () => headers,
    /** The cookie value the renderer session carries; never the token itself. */
    sessionToken: () => localHostSessionToken(controlToken),
    async start() {
      const ready = await waitForLocalHostReady(baseUrl, { timeoutMs: 20_000, headers });
      if (!ready) {
        throw new Error(`No SimForge Studio host answered at ${baseUrl}. Start it there with \`simforge daemon --port <port> --hostname <address>\`, or choose another connection.`);
      }
      const contract = await checkContract(baseUrl, controlToken);
      if (!contract.ok) {
        throw new Error(`The Studio host at ${baseUrl} is not this application's: ${contract.reason}. Run the same Studio version on both machines.`);
      }
      return { baseUrl, owned: false };
    },
    /** Is the host still answering with our credentials? One bounded request, no retries. */
    async probe() {
      const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      return response !== null && response.ok;
    },
    async stop() {},
  };
}
