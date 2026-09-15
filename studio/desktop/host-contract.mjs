// What the shell requires of any Studio host it loads, local or remote.
//
// A host is adopted only when it is this application's: same capability
// schema and same Studio version. Another version's host (an older install
// still running, or a remote box on a different release) is reported, never
// adopted, so UI and service never disagree on contracts.

import { app } from "electron";

const CAPABILITIES_SCHEMA = "simforge.studio-host-capabilities/v1";

/**
 * @param {string} baseUrl
 * @param {string} controlToken
 * @returns {Promise<{ ok: true } | { ok: false; reason: string }>}
 */
export async function checkContract(baseUrl, controlToken) {
  const response = await fetch(`${baseUrl}/api/simforge/host/capabilities`, {
    headers: { authorization: `Bearer ${controlToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => ({ ok: false, status: 0, statusText: String(error?.message ?? error), json: async () => null }));
  if (!response.ok) return { ok: false, reason: `capabilities answered ${response.status} ${response.statusText}` };
  const capabilities = await response.json().catch(() => null);
  if (!capabilities || capabilities.schema !== CAPABILITIES_SCHEMA) return { ok: false, reason: `unexpected capabilities schema ${capabilities?.schema}` };
  const version = capabilities.host?.version;
  if (version !== app.getVersion()) return { ok: false, reason: `host is Studio ${version ?? "unknown"}, this application is ${app.getVersion()}` };
  return { ok: true };
}
