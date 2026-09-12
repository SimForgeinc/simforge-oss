// Certifies what a SimForge Studio installer may be redistributed as.
//
// The ledger (scripts/release/bundled-components.json) records, per bundled
// third-party component, the license that actually applies and the
// obligations that follow. This module makes that record load-bearing:
//
//   1. It binds the ledger to the sources the product actually builds. The
//      encoder determination names the Git commits it was made from, and
//      those must equal the ones studio/desktop/encoders.lock.json pins.
//      Repin the lock and the determination stops applying, so the audit
//      fails until someone re-establishes it — a new encoder build cannot
//      inherit the previous one's clearance.
//   2. It turns obligations into a per-platform verdict. A platform is
//      `cleared` only when every obligation touching it is `satisfied`;
//      `unsatisfied` and `undetermined` both block, because "nobody checked"
//      is not permission. `satisfied-by-accompaniment` is the GPL
//      corresponding-source case: it clears only when the release actually
//      carries the archive for that platform, which the caller proves by
//      passing the receipts `verifyEncoderReceipts` produced. Those are not
//      an assertion: each one is a tools-manifest.json written by the build
//      that made the binaries, proven to name the sources this repository
//      pins, next to a corresponding-source archive whose bytes hash to the
//      digest that manifest recorded. A promise to ship source later, a
//      platform name passed on a command line, or a fixture standing in for
//      an archive are all rejected.
//   3. It produces the notices text the release page and the download page
//      must carry, generated from the same record rather than written by
//      hand beside it.
//
// scripts/release/publish-desktop-release.mjs refuses to publish anything
// publicly readable unless this audit clears the platforms it is publishing.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AUDIT_SCHEMA = "simforge.desktop-license-audit/v1";
export const COMPONENTS_SCHEMA = "simforge.desktop-bundled-components/v1";

/** Release platform identity per studio/desktop target key. */
export const LOCK_TARGET_PLATFORM = Object.freeze({
  "linux-x64": "linux-x64",
  "win32-x64": "windows-x64",
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
});

/** Obligation statuses that permit public redistribution unconditionally. */
const CLEARED = new Set(["satisfied", "not-applicable"]);
/** Statuses that clear only when the release carries the named asset. */
const CLEARED_BY_ASSET = new Set(["satisfied-by-accompaniment"]);

/** @param {string} text */
function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {string} repoRoot
 * @returns {Promise<{ components: any; componentsDigest: string; encodersLock: any }>}
 */
export async function loadLedger(repoRoot) {
  const componentsPath = join(repoRoot, "scripts/release/bundled-components.json");
  const raw = await readFile(componentsPath, "utf8");
  const components = JSON.parse(raw);
  if (components.schema !== COMPONENTS_SCHEMA) {
    throw new Error(`${componentsPath}: expected schema ${COMPONENTS_SCHEMA}`);
  }
  const encodersLock = JSON.parse(await readFile(join(repoRoot, "studio/desktop/encoders.lock.json"), "utf8"));
  return { components, componentsDigest: digest(raw), encodersLock };
}

/**
 * The encoder determination must name the sources the build will actually
 * use. Returns the drift found, empty when the ledger is current.
 * @param {any} components
 * @param {any} encodersLock
 * @returns {{ source: string; ledger: string; lock: string }[]}
 */
export function sourceDrift(components, encodersLock) {
  const encoder = components.components.find((/** @type {any} */ entry) => entry.id === "ffmpeg-encoders");
  if (!encoder) throw new Error("bundled-components.json: no ffmpeg-encoders component");
  const determined = new Map(
    (encoder.builtFromSource?.sources ?? []).map((/** @type {any} */ entry) => [entry.id, entry.commit]),
  );
  /** @type {{ source: string; ledger: string; lock: string }[]} */
  const drift = [];
  for (const pinned of encodersLock.sources ?? []) {
    const ledgerCommit = determined.get(pinned.id);
    if (ledgerCommit !== pinned.commit) {
      drift.push({ source: pinned.id, ledger: ledgerCommit ?? "no determination", lock: pinned.commit });
    }
  }
  for (const [id] of determined) {
    if (!(encodersLock.sources ?? []).some((/** @type {any} */ entry) => entry.id === id)) {
      drift.push({ source: id, ledger: "determined", lock: "absent from encoders.lock.json" });
    }
  }
  return drift;
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The encoder-build receipts found under a directory, verified against both
 * this repository's source pins and the bytes on disk.
 *
 * A platform is only reported verified when all of this holds: a
 * tools-manifest.json of schema simforge.desktop-tools/v2 exists for it, it
 * was produced by a source build (`origin: "built-from-source"`), the source
 * commits it names are exactly the ones studio/desktop/encoders.lock.json
 * pins, and the corresponding-source archive it points at exists with the
 * size and sha256 it recorded. Anything else is a problem, reported by name.
 *
 * This is what makes "cleared with archives" a statement about the artifacts
 * a publication is actually carrying rather than about a flag someone typed.
 *
 * @param {{ repoRoot: string; dir: string }} options
 * @returns {Promise<{ verified: string[]; receipts: any[]; problems: string[] }>}
 */
export async function verifyEncoderReceipts({ repoRoot, dir }) {
  const encodersLock = JSON.parse(await readFile(join(repoRoot, "studio/desktop/encoders.lock.json"), "utf8"));
  const pinned = new Map((encodersLock.sources ?? []).map((/** @type {any} */ entry) => [entry.id, entry.commit]));
  /** @type {string[]} */
  const problems = [];
  /** @type {any[]} */
  const receipts = [];
  /** @type {Set<string>} */
  const verified = new Set();

  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "tools-manifest.json") continue;
    const manifestPath = join(entry.parentPath ?? dir, entry.name);
    /** @type {any} */
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      problems.push(`${manifestPath}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const platform = LOCK_TARGET_PLATFORM[manifest.target];
    if (!platform) {
      problems.push(`${manifestPath}: target ${JSON.stringify(manifest.target)} is not a release platform`);
      continue;
    }
    /** @type {string[]} */
    const failures = [];
    if (manifest.schema !== "simforge.desktop-tools/v2") failures.push(`schema is ${manifest.schema}`);
    if (manifest.origin !== "built-from-source") {
      failures.push(`origin is ${JSON.stringify(manifest.origin ?? null)}, so these encoders were not built from source`);
    }
    for (const [id, commit] of pinned) {
      const named = (manifest.sources ?? []).find((/** @type {any} */ source) => source.id === id);
      if (named?.commit !== commit) {
        failures.push(`${id} was built from ${named?.commit ?? "an unnamed commit"}, not the pinned ${commit}`);
      }
    }
    const declared = manifest.correspondingSource;
    if (!declared?.file || typeof declared.sha256 !== "string") {
      failures.push("records no corresponding-source archive");
    } else {
      const archive = join(dirname(manifestPath), declared.file);
      const info = await stat(archive).catch(() => null);
      if (!info?.isFile()) failures.push(`corresponding-source archive ${declared.file} is missing`);
      else if (info.size !== declared.sizeBytes) failures.push(`${declared.file} is ${info.size} bytes, the build recorded ${declared.sizeBytes}`);
      else if ((await sha256File(archive)) !== declared.sha256) failures.push(`${declared.file} does not hash to the digest the build recorded`);
    }
    if (failures.length > 0) {
      problems.push(...failures.map((failure) => `${platform}: ${failure}`));
      continue;
    }
    verified.add(platform);
    receipts.push({
      platform,
      manifest: manifestPath,
      builtAt: manifest.builtAt ?? null,
      tools: manifest.tools,
      sources: manifest.sources,
      correspondingSource: { ...declared, path: join(dirname(manifestPath), declared.file) },
    });
  }
  return { verified: [...verified].sort(), receipts, problems };
}

/**
 * @param {{ repoRoot: string; platforms?: string[]; encoderReceipts?: { verified: string[]; problems: string[] } | null; now?: string }} options
 * @returns {Promise<any>} a simforge.desktop-license-audit/v1 receipt
 */
export async function auditBundledComponents({ repoRoot, platforms, encoderReceipts = null, now = new Date().toISOString() }) {
  const { components, componentsDigest, encodersLock } = await loadLedger(repoRoot);
  const audited = platforms ?? Object.values(LOCK_TARGET_PLATFORM);
  const drift = sourceDrift(components, encodersLock);
  const accompanied = new Set(encoderReceipts?.verified ?? []);

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
      .filter((entry) => {
        if (!entry.platforms.includes(platform)) return false;
        if (CLEARED.has(entry.status)) return false;
        // Accompaniment is proven, not promised: the archive for this
        // platform must be part of the publication.
        if (CLEARED_BY_ASSET.has(entry.status)) return !accompanied.has(platform);
        return true;
      })
      .map((entry) => (CLEARED_BY_ASSET.has(entry.status)
        ? `${entry.component}: ${entry.kind} requires a verified encoder-build receipt and corresponding-source archive for ${platform}`
        : `${entry.component}: ${entry.kind} (${entry.status})`));
    const driftHere = drift.map((entry) => `ffmpeg-encoders: ledger names ${entry.source} ${entry.ledger}, encoders.lock.json pins ${entry.lock}`);
    const blockedBy = [...blocking, ...driftHere];
    perPlatform[platform] = { redistribution: blockedBy.length === 0 ? "cleared" : "blocked", blockedBy };
  }

  const blocked = Object.entries(perPlatform).filter(([, verdict]) => verdict.redistribution !== "cleared");
  return {
    schema: AUDIT_SCHEMA,
    auditedAt: now,
    ledger: { file: "scripts/release/bundled-components.json", sha256: componentsDigest, reviewedAt: components.reviewedAt },
    encoders: {
      file: "studio/desktop/encoders.lock.json",
      license: encodersLock.license?.id ?? null,
      sources: (encodersLock.sources ?? []).map((/** @type {any} */ entry) => ({ id: entry.id, commit: entry.commit })),
      correspondingSourceVerified: [...accompanied].sort(),
      receiptProblems: encoderReceipts?.problems ?? [],
    },
    platforms: perPlatform,
    obligations,
    sourceDrift: drift,
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
    // A component whose payload mixes provenances credits each one here. CC BY
    // 4.0 is satisfied by the notice itself, not by a pointer to it: the
    // credit line, the licence terms and the statement of modification must be
    // in this document, so they are rendered rather than merely recorded.
    for (const determined of component.provenance?.classes ?? []) {
      const provenanceClass = /** @type {any} */ (determined);
      lines.push(`### ${provenanceClass.source} (${provenanceClass.models} models)`, "");
      lines.push(`- Attribution: ${provenanceClass.attributionApplied ?? provenanceClass.attribution}`);
      if (provenanceClass.attributionApplied) lines.push(`  - As recorded upstream: ${provenanceClass.attribution}`);
      lines.push(`- Terms: ${provenanceClass.terms}`);
      if (provenanceClass.modifications) lines.push(`- Modifications: ${provenanceClass.modifications}`);
      lines.push("");
    }
    if (component.provenance?.note) lines.push(component.provenance.note, "");
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
