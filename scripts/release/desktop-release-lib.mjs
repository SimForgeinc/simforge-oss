// Turning a set of built installers into a publishable release: what the
// assets are, what the release record says about them, what the download
// page is told, and which publication states the evidence permits.
//
// Nothing here rebuilds, renames or relabels a binary. The bytes are the
// bytes CI produced: their digests are verified against the checksum file
// that accompanied them, and the only transformation applied to a file name
// is the space→hyphen substitution GitHub would otherwise force (see
// safeAssetName in studio/desktop/release-identity.mjs). The embedded
// version token is never touched, so a release cannot claim its binaries
// were built as something they were not.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  CHANNEL_PRERELEASE,
  REQUIRED_PLATFORMS,
  assertLabel,
  assertLabelMatchesBuild,
  classifyAsset,
  releaseTag,
  safeAssetName,
} from "../../studio/desktop/release-identity.mjs";

export const RELEASE_SCHEMA = "simforge.desktop-release/v2";
export const DOWNLOADS_SCHEMA = "simforge.downloads/v1";
export const REPOSITORY = "SimForgeinc/simforge-oss";
export const SUMS_FILE = "SHA256SUMS";
export const RELEASE_FILE = "RELEASE.json";
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/** Files that are installers. `.blockmap` is emitted by electron-builder and unused without an update feed. */
const INSTALLER_EXTENSIONS = [".exe", ".dmg", ".zip", ".appimage", ".deb"];

/** What a platform's binaries were signed with. Anything else is a lie about trust. */
export const SIGNING_STATES = Object.freeze({
  windows: ["unsigned", "authenticode"],
  macos: ["ad-hoc", "developer-id", "developer-id-notarized"],
  linux: ["unsigned"],
});

/** @param {string} path */
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * `<hex>  <path>` per line, the format sha256sum reads and writes.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64})\s\s?(.+)$/.exec(line);
    if (!match) throw new Error(`unreadable checksum line: ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * @param {{ assetName: string; sha256: string }[]} assets
 * @returns {string}
 */
export function formatSums(assets) {
  return `${assets.map((asset) => `${asset.sha256}  ${asset.assetName}`).join("\n")}\n`;
}

/** @param {string} dir */
async function installerFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    if (!INSTALLER_EXTENSIONS.some((extension) => name.endsWith(extension))) continue;
    found.push(join(entry.parentPath ?? dir, entry.name));
  }
  return found.sort();
}

/**
 * Merge every `SHA256SUMS` found under a directory, keyed by the file name
 * each line names. CI uploads one per packaging leg — the leg that produced
 * the bytes is the only place their digest can be recorded before they
 * travel — so a downloaded run has four of them.
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
export async function collectSumsFiles(dir) {
  const merged = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name !== SUMS_FILE) continue;
    const sums = parseSums(await readFile(join(entry.parentPath ?? dir, entry.name), "utf8"));
    for (const [file, sha256] of sums) {
      const previous = merged.get(file);
      if (previous && previous !== sha256) {
        throw new Error(`${file} has two different digests in the checksum files: ${previous} and ${sha256}`);
      }
      merged.set(file, sha256);
    }
  }
  if (merged.size === 0) throw new Error(`${dir}: no ${SUMS_FILE} found`);
  return merged;
}

/**
 * The digests a previously recorded release states, so an installer set
 * fetched from CI can be proven identical to the one that was qualified.
 * Reads both the v1 preview record (`installers[]`) and this tool's v2
 * record (`assets[]`).
 * @param {any} record
 * @returns {Map<string, string>}
 */
export function sumsFromReleaseRecord(record) {
  const entries = record.assets ?? record.installers;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("release record lists no installers");
  const sums = new Map();
  for (const entry of entries) {
    const name = entry.originalFilename ?? entry.filename ?? entry.assetName;
    if (typeof name !== "string" || typeof entry.sha256 !== "string") {
      throw new Error("release record entry has no file name and digest");
    }
    sums.set(name, entry.sha256);
  }
  return sums;
}

/**
 * CI names each uploaded artifact after the signing it actually performed,
 * decided from the secrets present at build time
 * (.github/workflows/desktop.yml). Reading the signing state back out of
 * those names is the only honest source: there is deliberately no flag that
 * lets a publication assert its binaries are signed.
 *
 * @param {string} dir a `gh run download` directory
 * @returns {Promise<{ windows: string; macos: string; linux: string }>}
 */
export async function signingFromArtifactDirs(dir) {
  const pattern = /^simforge-studio-(windows-x64|linux-x64|macos-arm64|macos-x64)-(unsigned|signed|signed-notarized)$/;
  /** @type {Map<string, string>} */
  const perPlatform = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = pattern.exec(entry.name);
    if (match) perPlatform.set(match[1], match[2]);
  }
  if (perPlatform.size === 0) throw new Error(`${dir}: no simforge-studio-<platform>-<signing> artifact directories`);

  const state = (/** @type {string} */ platform, /** @type {Record<string, string>} */ mapping) => {
    const label = perPlatform.get(platform);
    if (!label) throw new Error(`${dir}: no artifact for ${platform}, so its signing state is unknown`);
    const value = mapping[label];
    if (!value) throw new Error(`${platform}: unsupported signing label ${label}`);
    return value;
  };
  const macArm = state("macos-arm64", { unsigned: "ad-hoc", signed: "developer-id", "signed-notarized": "developer-id-notarized" });
  const macIntel = state("macos-x64", { unsigned: "ad-hoc", signed: "developer-id", "signed-notarized": "developer-id-notarized" });
  if (macArm !== macIntel) {
    throw new Error(`the macOS legs disagree about signing: arm64 ${macArm}, x64 ${macIntel}`);
  }
  return {
    windows: state("windows-x64", { unsigned: "unsigned", signed: "authenticode", "signed-notarized": "authenticode" }),
    macos: macArm,
    linux: state("linux-x64", { unsigned: "unsigned", signed: "unsigned", "signed-notarized": "unsigned" }),
  };
}

/** Name tokens electron-builder appends after the version: os, then arch. */
const PLATFORM_TOKENS = new Set(["win", "mac", "linux", "darwin", "x64", "x86_64", "amd64", "arm64", "ia32", "armv7l"]);

/**
 * The version an artifact embeds, read from its own name.
 *
 * `artifactName` is `SimForge-Studio[-Setup]-${version}-${os}-${arch}.${ext}`
 * and a version may itself contain hyphens (`0.1.1-rc.1`), so the version is
 * everything between the product name and the first platform token rather
 * than whatever a greedy pattern happens to accept. Reading it from the
 * artifacts is deliberate: the publication states the version the binaries
 * actually carry, not the one a flag claims.
 *
 * @param {string} assetName
 * @returns {string}
 */
export function embeddedVersionFromAssetName(assetName) {
  const withoutExtension = assetName.replace(/\.(exe|dmg|zip|AppImage|deb)$/i, "");
  const tokens = withoutExtension.split("-");
  if (tokens[0] !== "SimForge" || tokens[1] !== "Studio") {
    throw new Error(`${assetName}: not a SimForge Studio artifact name`);
  }
  let index = tokens[2] === "Setup" ? 3 : 2;
  /** @type {string[]} */
  const version = [];
  while (index < tokens.length && !PLATFORM_TOKENS.has(tokens[index])) {
    version.push(tokens[index]);
    index += 1;
  }
  const embedded = version.join("-");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(embedded)) {
    throw new Error(`${assetName}: no version could be read from the artifact name (found ${JSON.stringify(embedded)})`);
  }
  return embedded;
}

/**
 * The one version an installer set embeds. A set spanning several versions is
 * not a release: it is a mixed pile of artifacts from different builds.
 * @param {{ assetName: string }[]} assets
 * @returns {string}
 */
export function embeddedVersionOf(assets) {
  const versions = new Set(assets.map((asset) => embeddedVersionFromAssetName(asset.assetName)));
  if (versions.size !== 1) {
    throw new Error(`the installer set embeds ${versions.size} versions (${[...versions].join(", ")})`);
  }
  return /** @type {string} */ ([...versions][0]);
}

/**
 * The assets of a publication, read from a directory of built installers.
 *
 * `expectedSums` is the checksum file that travelled with those installers
 * (CI's, or the local mirror's). When given, every digest must match it and
 * every file it lists must be present: a publication may not quietly ship a
 * rebuilt or truncated artifact. Coverage of all four platforms is required
 * because a partial installer set published as a release strands users of
 * the missing platform on a page that looks complete.
 *
 * @param {{ dir: string; expectedSums?: Map<string, string> | null; requirePlatforms?: boolean }} options
 * @returns {Promise<{ assets: any[]; verifiedAgainstSums: boolean }>}
 */
export async function collectInstallers({ dir, expectedSums = null, requirePlatforms = true }) {
  const files = await installerFiles(dir);
  if (files.length === 0) throw new Error(`${dir}: no installer artifacts found`);

  /** @type {any[]} */
  const assets = [];
  /** @type {Map<string, string>} */
  const byAssetName = new Map();
  for (const file of files) {
    const originalFilename = basename(file);
    const assetName = safeAssetName(originalFilename);
    const previous = byAssetName.get(assetName);
    if (previous) {
      throw new Error(`${originalFilename} and ${previous} both become the asset name ${assetName}`);
    }
    byAssetName.set(assetName, originalFilename);
    const { platform, kind } = classifyAsset(originalFilename);
    const [sha256, stats] = await Promise.all([sha256File(file), stat(file)]);
    assets.push({
      platform,
      kind,
      originalFilename,
      assetName,
      sha256,
      sizeBytes: stats.size,
      sourcePath: relative(dir, file),
    });
  }

  let verifiedAgainstSums = false;
  if (expectedSums) {
    /** @type {string[]} */
    const problems = [];
    const matched = new Set();
    for (const asset of assets) {
      const candidates = [asset.sourcePath, asset.originalFilename, asset.assetName];
      const key = candidates.find((candidate) => expectedSums.has(candidate));
      if (!key) {
        problems.push(`${asset.sourcePath} is not listed in the checksum file`);
        continue;
      }
      matched.add(key);
      if (expectedSums.get(key) !== asset.sha256) {
        problems.push(`${asset.sourcePath}: built ${asset.sha256}, checksum file says ${expectedSums.get(key)}`);
      }
    }
    for (const key of expectedSums.keys()) {
      if (!matched.has(key)) problems.push(`${key} is listed in the checksum file but was not found`);
    }
    if (problems.length > 0) throw new Error(`installer set does not match its checksum file:\n  ${problems.join("\n  ")}`);
    verifiedAgainstSums = true;
  }

  if (requirePlatforms) {
    const covered = new Set(assets.map((asset) => asset.platform));
    const missing = REQUIRED_PLATFORMS.filter((platform) => !covered.has(platform));
    if (missing.length > 0) throw new Error(`installer set covers no ${missing.join(", ")} artifact`);
  }

  assets.sort((left, right) => left.assetName.localeCompare(right.assetName));
  return { assets, verifiedAgainstSums };
}

/** @param {string} tag @param {string} assetName */
export function assetUrl(tag, assetName) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${assetName}`;
}

/** @param {string} tag */
export function releasePageUrl(tag) {
  return `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
}

/**
 * @param {{ windows: string; macos: string; linux: string }} signing
 */
function assertSigning(signing) {
  for (const [os, allowed] of Object.entries(SIGNING_STATES)) {
    const state = signing[/** @type {keyof typeof signing} */ (os)];
    if (!allowed.includes(state)) {
      throw new Error(`signing.${os} must be one of ${allowed.join(", ")}, got ${JSON.stringify(state)}`);
    }
  }
  return signing;
}

/**
 * The release record attached to the publication and mirrored beside the
 * installers. It is the artifact that lets someone months later answer
 * "which source, which stack, which service, which trust level, which
 * qualification" without reading a workflow log.
 *
 * @param {{
 *   label: string;
 *   channel: string;
 *   embeddedVersion: string;
 *   source: { revision: string; branch?: string | null; treeSha256?: string | null };
 *   cloud: { origin: string; revision?: string | null };
 *   stack: { stackVersion: string; stackConfigSha256: string; vendorLockRevision?: string | null; published?: boolean };
 *   signing: { windows: string; macos: string; linux: string };
 *   assets: any[];
 *   audit: any;
 *   qualification: { interactivePlatforms: string[]; packagingVerified: string[]; evidence?: string[] };
 *   ci?: { runId: number | null; url: string | null } | null;
 *   publication: { state: string; publicallyReadable: boolean };
 *   now?: string;
 * }} input
 */
export function buildReleaseRecord(input) {
  const { label, channel, embeddedVersion } = input;
  assertLabel(label);
  assertLabelMatchesBuild({ label, embeddedVersion });
  if (!Object.hasOwn(CHANNEL_PRERELEASE, channel)) throw new Error(`unknown channel ${channel}`);
  assertSigning(input.signing);
  const tag = releaseTag(label);

  return {
    schema: RELEASE_SCHEMA,
    recordedAt: input.now ?? new Date().toISOString(),
    tag,
    distributionLabel: label,
    embeddedVersion,
    channel,
    publication: input.publication,
    source: {
      repository: REPOSITORY,
      revision: input.source.revision,
      branch: input.source.branch ?? null,
      treeSha256: input.source.treeSha256 ?? null,
    },
    cloud: { origin: input.cloud.origin, revision: input.cloud.revision ?? null },
    stack: {
      stackVersion: input.stack.stackVersion,
      stackConfigSha256: input.stack.stackConfigSha256,
      vendorLockRevision: input.stack.vendorLockRevision ?? null,
      published: input.stack.published ?? false,
    },
    signing: input.signing,
    qualification: input.qualification,
    licenseAudit: {
      schema: input.audit.schema,
      ledgerSha256: input.audit.ledger.sha256,
      publicRedistribution: input.audit.publicRedistribution,
      blockedPlatforms: input.audit.blockedPlatforms,
    },
    installerCi: input.ci ?? null,
    assets: input.assets.map((asset) => ({
      platform: asset.platform,
      kind: asset.kind,
      originalFilename: asset.originalFilename,
      assetName: asset.assetName,
      url: assetUrl(tag, asset.assetName),
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
    })),
    checksums: { file: SUMS_FILE, url: assetUrl(tag, SUMS_FILE) },
    notices: {
      thirdParty: assetUrl(tag, NOTICES_FILE),
      // Per platform, filled in by the publisher from the archives it
      // actually attaches; null when none accompany the release.
      correspondingSource: null,
      // The licence the bundled encoders are distributed under, stated once
      // here so a download page renders our metadata instead of hardcoding a
      // claim that could drift from the real closure.
      bundledEncoderLicense: "GPL-3.0-or-later",
    },
  };
}

/**
 * What the product site publishes. Only released (publicly readable)
 * publications become channel pointers: a draft is invisible to anonymous
 * users, so advertising it would produce a download page whose links 404.
 *
 * @param {{ releases: any[]; previous?: any | null; now?: string }} input
 */
export function buildDownloadsManifest({ releases, previous = null, now = new Date().toISOString() }) {
  /** @type {Record<string, any>} */
  const entries = { ...(previous?.releases ?? {}) };
  /** @type {Record<string, string | null>} */
  const channels = { stable: previous?.channels?.stable ?? null, preview: previous?.channels?.preview ?? null };

  for (const release of releases) {
    entries[release.tag] = {
      tag: release.tag,
      distributionLabel: release.distributionLabel,
      embeddedVersion: release.embeddedVersion,
      channel: release.channel,
      sourceRevision: release.source.revision,
      cloudOrigin: release.cloud.origin,
      releasePage: releasePageUrl(release.tag),
      checksumsUrl: release.checksums.url,
      notices: release.notices,
      signing: release.signing,
      interactivelyQualified: release.qualification.interactivePlatforms,
      generatedAt: release.recordedAt,
      assets: release.assets.map((asset) => ({
        platform: asset.platform,
        kind: asset.kind,
        assetName: asset.assetName,
        originalFilename: asset.originalFilename,
        url: asset.url,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
      })),
    };
    if (release.publication.publicallyReadable) channels[release.channel] = release.tag;
  }

  return { schema: DOWNLOADS_SCHEMA, generatedAt: now, channels, releases: entries };
}

/**
 * The release page body. Every limitation a user needs before they run an
 * installer is stated here, in the release itself, not only on a web page we
 * might forget to update: which service it talks to, what it is signed with,
 * which platforms were actually exercised interactively, and which
 * third-party obligations are unresolved.
 *
 * @param {{ release: any; audit: any }} input
 * @returns {string}
 */
export function renderReleaseNotes({ release, audit }) {
  const platformRow = (/** @type {string} */ platform) => {
    const os = platform.startsWith("windows") ? "windows" : platform.startsWith("macos") ? "macos" : "linux";
    const signing = release.signing[os];
    const qualified = release.qualification.interactivePlatforms.includes(platform);
    const cleared = audit.platforms?.[platform]?.redistribution === "cleared";
    return `| ${platform} | ${signing} | ${qualified ? "installed and exercised" : "packaged only"} | ${cleared ? "cleared" : "blocked"} |`;
  };

  const lines = [
    `# SimForge Studio ${release.distributionLabel}`,
    "",
    `Build \`${release.embeddedVersion}\` — the installers embed version ${release.embeddedVersion};`,
    `\`${release.distributionLabel}\` is the name of this distribution, not a different build.`,
    "",
    `- Source: [\`${release.source.revision}\`](https://github.com/${REPOSITORY}/commit/${release.source.revision})${release.source.branch ? ` (${release.source.branch})` : ""}`,
    `- SimForge stack: \`${release.stack.stackVersion}\`${release.stack.published ? "" : " (not published to npm/PyPI)"}`,
    `- Connects to: \`${release.cloud.origin}\`${release.cloud.revision ? ` at \`${release.cloud.revision}\`` : ""}`,
    `- Checksums: \`${SUMS_FILE}\` · third-party notices: \`${NOTICES_FILE}\``,
    "",
    "| Platform | Code signing | Qualification | Redistribution |",
    "|---|---|---|---|",
    ...REQUIRED_PLATFORMS.map(platformRow),
    "",
    "## Before you install",
    "",
  ];

  if (release.cloud.origin !== "https://simforge.ai") {
    lines.push(
      `- This build connects to **${release.cloud.origin}**, not the production service. Accounts, projects and jobs there are staging data.`,
    );
  }
  if (release.signing.windows === "unsigned") {
    lines.push("- The Windows installer is **not signed**. SmartScreen will report an unknown publisher.");
  }
  if (release.signing.macos === "ad-hoc") {
    lines.push(
      "- The macOS app is **ad-hoc signed and not notarized**. Gatekeeper refuses a quarantined download; opening it requires an explicit approval in System Settings › Privacy & Security.",
    );
  }
  if (release.signing.linux === "unsigned") {
    lines.push("- The Linux AppImage and deb are **not signed**.");
  }
  const notQualified = REQUIRED_PLATFORMS.filter((platform) => !release.qualification.interactivePlatforms.includes(platform));
  if (notQualified.length > 0) {
    lines.push(
      `- Interactive qualification of a downloaded installer was performed on ${release.qualification.interactivePlatforms.join(", ") || "no platform"}. ${notQualified.join(", ")} passed packaging verification only.`,
    );
  }
  lines.push(
    "- Your data (database, artifacts, map cache, job state) lives outside the install directory and is not removed by uninstalling.",
    "- Downloaded model weights live separately again, under `$SIMFORGE_ASSETS_ROOT` (default `~/simforge-assets`), and can be tens of gigabytes. Uninstalling the app does not delete them; `simforge models uninstall` or Remove on the Models screen does.",
    "- Local use needs no account. `richmond-field-station` is the only public map; other maps require an authorized SimCloud session.",
    "",
    "## Verifying what you downloaded",
    "",
    "```sh",
    `curl -LO ${assetUrl(release.tag, SUMS_FILE)}`,
    "sha256sum --check --ignore-missing SHA256SUMS",
    "```",
    "",
    "## Third-party components",
    "",
    `See \`${NOTICES_FILE}\`. The bundled ffmpeg/ffprobe encoders are built from pinned sources (FFmpeg and libx264) and are distributed under ${release.notices.bundledEncoderLicense}; the complete corresponding source of those executables is published with this release.`,
    "",
  );
  if (Array.isArray(release.notices.correspondingSource) && release.notices.correspondingSource.length > 0) {
    lines.push("Corresponding source of the bundled encoders:", "");
    for (const entry of release.notices.correspondingSource) lines.push(`- ${entry.platform}: ${entry.url}`);
    lines.push("");
  }

  if (audit.publicRedistribution !== "cleared") {
    lines.push("**Unresolved redistribution obligations:**", "");
    for (const platform of audit.blockedPlatforms) {
      for (const reason of audit.platforms[platform].blockedBy) lines.push(`- ${platform}: ${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
