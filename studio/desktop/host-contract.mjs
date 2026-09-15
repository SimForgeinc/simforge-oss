// What the shell requires of any Studio host it loads, local or remote.
//
// A host is adopted only when it is this application's: same capability
// schema, same host protocol version, and same Studio version. Another
// version's host (an older install still running, or a remote box on a
// different release) is reported, never adopted, so UI and service never
// disagree on contracts. The protocol rule itself is not decided here: every
// client asks `checkHostProtocolVersion` from @simforge-oss/studio-host, so
// the shell, the CLI and the worker cannot drift on what "compatible" means.

import { STUDIO_HOST_CAPABILITIES_SCHEMA, checkHostProtocolVersion } from "@simforge-oss/studio-host";
import { app } from "electron";

/**
 * @param {string} baseUrl
 * @param {string} controlToken
 * @returns {Promise<
 *   | { ok: true; host: { version: string | null; protocolVersion: number; transports: string[] } }
 *   | { ok: false; reason: string }
 * >}
 */
export async function checkContract(baseUrl, controlToken) {
  const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, {
    headers: { authorization: `Bearer ${controlToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => ({ ok: false, status: 0, statusText: String(error?.message ?? error), json: async () => null }));
  if (!response.ok) return { ok: false, reason: `capabilities answered ${response.status} ${response.statusText}` };
  const capabilities = await response.json().catch(() => null);
  if (!capabilities || capabilities.schema !== STUDIO_HOST_CAPABILITIES_SCHEMA) return { ok: false, reason: `unexpected capabilities schema ${capabilities?.schema}` };
  const protocol = checkHostProtocolVersion(capabilities);
  if (!protocol.ok) return { ok: false, reason: protocol.reason };
  const version = capabilities.host?.version ?? null;
  if (version !== app.getVersion()) return { ok: false, reason: `host is Studio ${version ?? "unknown"}, this application is ${app.getVersion()}` };
  const transports = Array.isArray(capabilities.transports) ? capabilities.transports.filter((item) => typeof item === "string") : [];
  return { ok: true, host: { version, protocolVersion: protocol.protocolVersion, transports } };
}
