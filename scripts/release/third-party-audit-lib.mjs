// Certifies what a SimForge Studio installer may be redistributed as.
//
// The ledger (scripts/release/bundled-components.json) records, per bundled
// third-party component, the license that actually applies and the
// obligations that follow. This module makes that record load-bearing:
//
//   1. It binds the ledger to bytes. Every per-target license determination
//      names the digests of the exact binaries it was made from, and those
//      digests must equal the pins in studio/desktop/tools.lock.json. Repin
//      the lock and the determination stops applying, so the audit fails
//      until someone re-establishes it — a new encoder build cannot inherit
//      the previous one's clearance.
//   2. It turns obligations into a per-platform verdict. A platform is
//      `cleared` only when every obligation touching it is `satisfied`;
//      `unsatisfied` and `undetermined` both block, because "nobody checked"
//      is not permission.
//   3. It produces the notices text the release page and the download page
//      must carry, generated from the same record rather than written by
//      hand beside it.
//
// scripts/release/publish-desktop-release.mjs refuses to publish anything
// publicly readable unless this audit clears the platforms it is publishing.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const AUDIT_SCHEMA = "simforge.desktop-license-audit/v1";
export const COMPONENTS_SCHEMA = "simforge.desktop-bundled-components/v1";

/** Release platform identity per studio/desktop/tools.lock.json target key. */
export const LOCK_TARGET_PLATFORM = Object.freeze({
  "linux-x64": "linux-x64",
  "win32-x64": "windows-x64",
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
});

/** Obligation statuses that permit public redistribution. */
const CLEARED = new Set(["satisfied", "not-applicable"]);

/** @param {string} text */
function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {string} repoRoot
 * @returns {Promise<{ components: any; componentsDigest: string; toolsLock: any }>}
 */
export async function loadLedger(repoRoot) {
  const componentsPath = join(repoRoot, "scripts/release/bundled-components.json");
  const raw = await readFile(componentsPath, "utf8");
  const components = JSON.parse(raw);
  if (components.schema !== COMPONENTS_SCHEMA) {
    throw new Error(`${componentsPath}: expected schema ${COMPONENTS_SCHEMA}`);
  }
  const toolsLock = JSON.parse(await readFile(join(repoRoot, "studio/desktop/tools.lock.json"), "utf8"));
  return { components, componentsDigest: digest(raw), toolsLock };
}

/**
 * Every per-target encoder determination must describe the binaries the lock
 * pins. Returns the drift found, empty when the ledger is current.
 * @param {any} components
 * @param {any} toolsLock
 * @returns {{ platform: string; tool: string; ledger: string; lock: string }[]}
 */
export function pinDrift(components, toolsLock) {
  const encoder = components.components.find((/** @type {any} */ entry) => entry.id === "ffmpeg-encoders");
  if (!encoder) throw new Error("bundled-components.json: no ffmpeg-encoders component");
  /** @type {{ platform: string; tool: string; ledger: string; lock: string }[]} */
  const drift = [];
  for (const [lockKey, platform] of Object.entries(LOCK_TARGET_PLATFORM)) {
    const locked = toolsLock.ffmpeg?.targets?.[lockKey];
    const determined = encoder.perTarget?.[platform];
    if (!locked) {
      drift.push({ platform, tool: "*", ledger: "determined", lock: "absent from tools.lock.json" });
      continue;
    }
    if (!determined) {
      drift.push({ platform, tool: "*", ledger: "no determination", lock: "pinned in tools.lock.json" });
      continue;
    }
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const ledgerPin = determined.binaryPins?.[tool];
      const lockPin = locked[tool]?.sha256;
      if (ledgerPin !== lockPin) {
        drift.push({ platform, tool, ledger: ledgerPin ?? "missing", lock: lockPin ?? "missing" });
      }
    }
  }
  return drift;
}

/**
 * @param {{ repoRoot: string; platforms?: string[]; now?: string }} options
 * @returns {Promise<any>} a simforge.desktop-license-audit/v1 receipt
 */
export async function auditBundledComponents({ repoRoot, platforms, now = new Date().toISOString() }) {
  const { components, componentsDigest, toolsLock } = await loadLedger(repoRoot);
  const audited = platforms ?? Object.values(LOCK_TARGET_PLATFORM);
  const drift = pinDrift(components, toolsLock);

  /** @type {any[]} */
  const obligations = [];
  for (const component of components.components) {
    for (const obligation of component.obligations ?? []) {
      const scope = obligation.targets ?? audited;
      const affected = scope.filter((/** @type {string} */ platform) => audited.includes(platform));
      if (affected.length === 0) continue;
      obligations.push({
        component: component.id,
        kind: obligation.kind,
        platforms: affected,
        status: obligation.status,
        requirement: obligation.requirement,
        evidence: obligation.evidence ?? null,
        remediation: obligation.remediation ?? null,
      });
    }
  }

  /** @type {Record<string, { redistribution: string; blockedBy: string[] }>} */
  const perPlatform = {};
  for (const platform of audited) {
    const blocking = obligations
      .filter((entry) => entry.platforms.includes(platform) && !CLEARED.has(entry.status))
      .map((entry) => `${entry.component}: ${entry.kind} (${entry.status})`);
    const driftHere = drift.filter((entry) => entry.platform === platform)
      .map((entry) => `ffmpeg-encoders: ledger pin for ${entry.tool} does not match tools.lock.json`);
    const blockedBy = [...blocking, ...driftHere];
    perPlatform[platform] = { redistribution: blockedBy.length === 0 ? "cleared" : "blocked", blockedBy };
  }

  const blocked = Object.entries(perPlatform).filter(([, verdict]) => verdict.redistribution !== "cleared");
  return {
    schema: AUDIT_SCHEMA,
    auditedAt: now,
    ledger: { file: "scripts/release/bundled-components.json", sha256: componentsDigest, reviewedAt: components.reviewedAt },
    toolsLock: { file: "studio/desktop/tools.lock.json", distributionTag: toolsLock.ffmpeg?.source ?? null },
    platforms: perPlatform,
    obligations,
    pinDrift: drift,
    publicRedistribution: blocked.length === 0 ? "cleared" : "blocked",
    blockedPlatforms: blocked.map(([platform]) => platform),
    neverShipped: components.neverShipped ?? [],
  };
}

/**
 * The reasons a set of platforms may not be published publicly, empty when
 * they may. Publication uses this; it does not re-derive the rule.
 * @param {any} receipt
 * @param {string[]} platforms
 * @returns {string[]}
 */
export function blockingReasons(receipt, platforms) {
  return platforms.flatMap((platform) => {
    const verdict = receipt.platforms?.[platform];
    if (!verdict) return [`${platform}: not covered by the license audit`];
    return verdict.blockedBy.map((/** @type {string} */ reason) => `${platform}: ${reason}`);
  });
}

/**
 * The notices document a public download must carry, generated from the
 * ledger so it cannot describe a different package than the audit did.
 * @param {{ receipt: any; components: any; release?: { tag: string; sourceRevision: string } | null }} options
 * @returns {string}
 */
export function renderThirdPartyNotices({ receipt, components, release = null }) {
  const lines = [
    "# Third-party notices — SimForge Studio",
    "",
    release
      ? `Release \`${release.tag}\`, built from simforge-oss \`${release.sourceRevision}\`.`
      : "Generated from scripts/release/bundled-components.json.",
    "",
    `Ledger digest \`${receipt.ledger.sha256}\`; reviewed ${receipt.ledger.reviewedAt}.`,
    "",
    "SimForge Studio is Apache-2.0. It redistributes the third-party components",
    "below. Where a component's license differs per platform, the platform is",
    "named: the installers do not carry identical third-party payloads.",
    "",
  ];

  for (const component of components.components) {
    lines.push(`## ${component.id}`, "", component.role, "");
    if (component.license) lines.push(`License: ${component.license}`, "");
    if (component.origin) lines.push(`Origin: ${component.origin}`, "");
    if (component.distributionVehicle) {
      lines.push(
        `Delivered through ${component.distributionVehicle.repository} at \`${component.distributionVehicle.tag}\`.`,
        component.distributionVehicle.note,
        "",
      );
    }
    for (const [platform, determined] of Object.entries(component.perTarget ?? {})) {
      const target = /** @type {any} */ (determined);
      lines.push(
        `### ${platform}`,
        "",
        `- Upstream: ${target.builder}, ffmpeg ${target.upstreamVersion}`,
        `- License: **${target.declaredLicense}**`,
        `- Determined from: ${target.declaredBy}`,
        `- Copyleft components linked: ${(target.copyleftComponents ?? []).join(", ") || "none recorded"}`,
        `- Redistribution: ${target.redistribution}`,
        "",
      );
      for (const evidence of target.evidence ?? []) {
        lines.push(`  - ${evidence.what}: ${evidence.url} (sha256 \`${evidence.sha256}\`)`);
      }
      lines.push("");
    }
    for (const obligation of component.obligations ?? []) {
      const scope = obligation.targets ? ` [${obligation.targets.join(", ")}]` : "";
      lines.push(`- Obligation (${obligation.kind})${scope}: **${obligation.status}** — ${obligation.requirement}`);
      if (obligation.evidence) lines.push(`  - Evidence: ${obligation.evidence}`);
      for (const step of obligation.remediation ?? []) lines.push(`  - Remediation: ${step}`);
    }
    lines.push("");
  }

  lines.push("## Never redistributed", "");
  for (const item of receipt.neverShipped) lines.push(`- ${item}`);
  lines.push("");

  if (receipt.publicRedistribution !== "cleared") {
    lines.push(
      "## Unresolved obligations",
      "",
      "The following platforms are not cleared for public redistribution; a",
      "release carrying them may exist only as a maintainers-only draft.",
      "",
    );
    for (const platform of receipt.blockedPlatforms) {
      for (const reason of receipt.platforms[platform].blockedBy) lines.push(`- ${platform}: ${reason}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}`;
}
