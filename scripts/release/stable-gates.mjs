#!/usr/bin/env node
// The gates a SimForge Studio release must clear before it may be the
// default download ("Latest"), and a runnable check for them.
//
//   node scripts/release/stable-gates.mjs --measurements <file.json> [--json]
//
// Every gate is a measurement someone made, passed in as data — this module
// decides, it does not guess. A missing measurement is a failed gate, never
// an assumed one: that is the whole point of the file. In particular there
// is no way to record "signed" without naming what signed it, so a stable
// release cannot be declared for unsigned binaries.
//
// A preview publication does not use these gates; it discloses its state
// instead (see renderReleaseNotes). Only the promotion to stable does.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_PLATFORMS, assertLabel } from "../../studio/desktop/release-identity.mjs";

export const GATES_SCHEMA = "simforge.desktop-stable-gates/v1";

const VERSION_LABEL = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * @typedef {{
 *   label: string;
 *   embeddedVersion: string;
 *   sourceRevision: string;
 *   sourceReachableFromMain: boolean | null;
 *   cloudOrigin: string;
 *   productionDesktopRoutes: { connect: number | null; session: number | null } | null;
 *   signing: { windows: string; macos: string; linux: string };
 *   interactivePlatforms: string[];
 *   licenseAudit: { publicRedistribution: string; blockedPlatforms: string[] } | null;
 *   stack: { stackVersion: string; tagged: boolean | null; published: boolean | null; vendorLockRevision: string | null } | null;
 *   updateCheckInBuild: boolean | null;
 * }} Measurements
 */

/**
 * @param {Measurements} m
 * @returns {{ schema: string; verdict: "pass" | "fail"; gates: { id: string; status: "pass" | "fail"; detail: string }[] }}
 */
export function evaluateStableGates(m) {
  /** @type {{ id: string; status: "pass" | "fail"; detail: string }[]} */
  const gates = [];
  /** @param {string} id @param {boolean} ok @param {string} detail */
  const gate = (id, ok, detail) => gates.push({ id, status: ok ? "pass" : "fail", detail });

  assertLabel(m.label);
  gate(
    "label-is-a-version",
    VERSION_LABEL.test(m.label) && m.label === m.embeddedVersion,
    `label ${m.label}, embedded version ${m.embeddedVersion}: a stable release is named by the version its binaries carry, not by a preview generation`,
  );

  gate(
    "source-landed-on-main",
    m.sourceReachableFromMain === true,
    m.sourceReachableFromMain === null
      ? "not measured: run git merge-base --is-ancestor <revision> origin/main"
      : `${m.sourceRevision} ${m.sourceReachableFromMain ? "is" : "is not"} reachable from origin/main`,
  );

  gate(
    "windows-authenticode",
    m.signing.windows === "authenticode",
    `windows signing: ${m.signing.windows}`,
  );
  gate(
    "macos-notarized",
    m.signing.macos === "developer-id-notarized",
    `macos signing: ${m.signing.macos}`,
  );

  const missingQualification = REQUIRED_PLATFORMS.filter((platform) => !m.interactivePlatforms.includes(platform));
  gate(
    "installed-qualification-every-platform",
    missingQualification.length === 0,
    missingQualification.length === 0
      ? `downloaded-installer qualification on ${m.interactivePlatforms.join(", ")}`
      : `no downloaded-installer qualification for ${missingQualification.join(", ")}`,
  );

  gate(
    "production-cloud-origin",
    m.cloudOrigin === "https://simforge.ai",
    `installers connect to ${m.cloudOrigin}`,
  );
  const routes = m.productionDesktopRoutes;
  gate(
    "production-serves-desktop-routes",
    routes?.connect === 200 && routes?.session === 401,
    routes === null
      ? "not measured: probe https://simforge.ai/desktop/connect and /api/desktop/session"
      : `/desktop/connect ${routes.connect}, /api/desktop/session ${routes.session} (expected 200 and 401)`,
  );

  gate(
    "license-obligations-cleared",
    m.licenseAudit?.publicRedistribution === "cleared",
    m.licenseAudit === null
      ? "not measured: run scripts/release/audit-bundled-licenses.mjs"
      : `redistribution ${m.licenseAudit.publicRedistribution}${m.licenseAudit.blockedPlatforms.length > 0 ? ` (blocked: ${m.licenseAudit.blockedPlatforms.join(", ")})` : ""}`,
  );

  const stack = m.stack;
  gate(
    "stack-identity-published",
    stack?.tagged === true && stack?.published === true,
    stack === null
      ? "not measured: check the v<stackVersion> tag and the registry"
      : `stack ${stack.stackVersion}: tag ${stack.tagged ? "present" : "absent"}, registry ${stack.published ? "published" : "not published"}`,
  );
  gate(
    "cloud-vendor-lock-matches-source",
    stack?.vendorLockRevision === m.sourceRevision,
    stack?.vendorLockRevision
      ? `Cloud vendor lock is at ${stack.vendorLockRevision}, installers are built from ${m.sourceRevision}`
      : "not measured: read vendor/simforge-oss/stack-lock.json source.revision in the Cloud repository",
  );

  gate(
    "update-path-in-build",
    m.updateCheckInBuild === true,
    m.updateCheckInBuild === null
      ? "not measured: check that the built revision contains studio/desktop/update-check.mjs"
      : `update check ${m.updateCheckInBuild ? "present in" : "absent from"} the built source`,
  );

  return { schema: GATES_SCHEMA, verdict: gates.every((entry) => entry.status === "pass") ? "pass" : "fail", gates };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.measurements !== "string") {
    process.stderr.write("usage: stable-gates.mjs --measurements <file.json> [--json]\n");
    process.exit(1);
  }
  const measurements = JSON.parse(await readFile(args.measurements, "utf8"));
  const result = evaluateStableGates(measurements);
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const entry of result.gates) {
      process.stdout.write(`${entry.status === "pass" ? "PASS" : "FAIL"}  ${entry.id}: ${entry.detail}\n`);
    }
    process.stdout.write(`\nstable release: ${result.verdict}\n`);
  }
  process.exit(result.verdict === "pass" ? 0 : 2);
}
