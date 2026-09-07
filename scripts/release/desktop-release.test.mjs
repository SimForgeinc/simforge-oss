// Contract tests for desktop release identity, asset handling, publication
// eligibility and the update check. Each case here corresponds to a way a
// release can be wrong in public: a tag that fires the stack publication
// workflow, a relabelled binary, a download link GitHub rewrote, a channel
// advertising an invisible draft, an unsigned build called stable, or a
// license determination that silently outlived the binary it was made from.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertLabel,
  assertLabelMatchesBuild,
  classifyAsset,
  parseReleaseTag,
  readDistributionIdentity,
  releaseTag,
  safeAssetName,
} from "../../studio/desktop/release-identity.mjs";
import {
  buildDownloadsManifest,
  collectInstallers,
  embeddedVersionFromAssetName,
  embeddedVersionOf,
  formatSums,
  parseSums,
} from "./desktop-release-lib.mjs";
import { auditBundledComponents, blockingReasons, loadLedger, sourceDrift, verifyEncoderReceipts } from "./third-party-audit-lib.mjs";
import { evaluateStableGates } from "./stable-gates.mjs";
import { checkForUpdates, describeUpdate, eligibleReleases, manifestReleases } from "../../studio/desktop/update-check.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;

test("desktop tags never enter the stack's v* namespace", () => {
  assert.equal(releaseTag("preview.1"), "studio-preview.1");
  assert.equal(releaseTag("0.1.1"), "studio-0.1.1");
  // A label that looks like a stack version would produce studio-v0.1.1,
  // which reads as a stack tag to anyone triaging a publish failure.
  assert.throws(() => releaseTag("v0.1.1"), /must not look like a stack version tag/);
  assert.throws(() => assertLabel("Preview.1"), /must match/);
  assert.throws(() => assertLabel("../escape"), /must match|\.\./);
});

test("the release list reader ignores stack tags and malformed desktop tags", () => {
  assert.equal(parseReleaseTag("studio-preview.1"), "preview.1");
  assert.equal(parseReleaseTag("v0.1.0-rc.61"), null);
  assert.equal(parseReleaseTag("studio-"), null);
  assert.equal(parseReleaseTag("studio-Preview"), null);
  assert.equal(parseReleaseTag(undefined), null);
});

test("a version label may only name the version the binaries carry", () => {
  // The first preview ships 0.1.0 bytes under a preview name: allowed, and
  // both identities are recorded.
  assertLabelMatchesBuild({ label: "preview.1", embeddedVersion: "0.1.0" });
  assertLabelMatchesBuild({ label: "0.1.1", embeddedVersion: "0.1.1" });
  assert.throws(
    () => assertLabelMatchesBuild({ label: "0.1.2", embeddedVersion: "0.1.0" }),
    /names a version but the binaries embed 0\.1\.0/,
  );
});

test("asset names lose spaces and nothing else", () => {
  assert.equal(safeAssetName("SimForge Studio-Setup-0.1.0-x64.exe"), "SimForge-Studio-Setup-0.1.0-x64.exe");
  assert.equal(safeAssetName("SimForge Studio-0.1.0-mac-arm64.dmg"), "SimForge-Studio-0.1.0-mac-arm64.dmg");
  assert.equal(safeAssetName("already-safe-0.1.0.deb"), "already-safe-0.1.0.deb");
  assert.throws(() => safeAssetName("dir/file.exe"), /carry no path/);
  assert.throws(() => safeAssetName("Studio (1).exe"), /cannot be made a safe asset name/);
});

test("platform and installer kind come from the artifact name", () => {
  assert.deepEqual(classifyAsset("SimForge-Studio-Setup-0.1.0-x64.exe"), { platform: "windows-x64", kind: "nsis" });
  assert.deepEqual(classifyAsset("SimForge-Studio-0.1.0-mac-arm64.zip"), { platform: "macos-arm64", kind: "zip" });
  assert.deepEqual(classifyAsset("SimForge-Studio-0.1.0-mac-x64.dmg"), { platform: "macos-x64", kind: "dmg" });
  assert.deepEqual(classifyAsset("SimForge-Studio-0.1.0-linux-x86_64.AppImage"), { platform: "linux-x64", kind: "appimage" });
  assert.throws(() => classifyAsset("SimForge-Studio-0.1.0.tar.gz"), /not a recognized/);
});

test("the embedded version is read from the artifact, hyphenated versions included", () => {
  assert.equal(embeddedVersionFromAssetName("SimForge-Studio-Setup-0.1.0-x64.exe"), "0.1.0");
  assert.equal(embeddedVersionFromAssetName("SimForge-Studio-0.1.0-linux-x86_64.AppImage"), "0.1.0");
  assert.equal(embeddedVersionFromAssetName("SimForge-Studio-0.1.1-rc.2-mac-arm64.dmg"), "0.1.1-rc.2");
  assert.throws(() => embeddedVersionOf([
    { assetName: "SimForge-Studio-0.1.0-mac-x64.dmg" },
    { assetName: "SimForge-Studio-0.1.1-x64.exe" },
  ]), /embeds 2 versions/);
});

test("checksum lines round-trip", () => {
  const assets = [{ assetName: "a.exe", sha256: "a".repeat(64) }, { assetName: "b.deb", sha256: "b".repeat(64) }];
  const parsed = parseSums(formatSums(assets));
  assert.equal(parsed.get("a.exe"), "a".repeat(64));
  assert.equal(parsed.size, 2);
  assert.throws(() => parseSums("not a checksum line\n"), /unreadable checksum line/);
});

/** A directory of stand-in installers with the real naming scheme. */
async function installerFixture(contents) {
  const dir = await mkdtemp(join(tmpdir(), "simforge-release-"));
  for (const [name, body] of Object.entries(contents)) await writeFile(join(dir, name), body);
  return dir;
}

const FIXTURE = {
  "SimForge Studio-Setup-0.1.0-x64.exe": "windows",
  "SimForge Studio-0.1.0-mac-arm64.dmg": "mac-arm",
  "SimForge Studio-0.1.0-mac-x64.dmg": "mac-x64",
  "SimForge Studio-0.1.0-linux-x86_64.AppImage": "linux",
};

test("an installer set is verified against the checksums it was built with", async () => {
  const dir = await installerFixture(FIXTURE);
  const { assets } = await collectInstallers({ dir });
  const good = new Map(assets.map((asset) => [asset.originalFilename, asset.sha256]));
  const verified = await collectInstallers({ dir, expectedSums: good });
  assert.equal(verified.verifiedAgainstSums, true);

  const tampered = new Map(good);
  tampered.set("SimForge Studio-Setup-0.1.0-x64.exe", "0".repeat(64));
  await assert.rejects(
    () => collectInstallers({ dir, expectedSums: tampered }),
    /does not match its checksum file[\s\S]*Setup-0\.1\.0-x64\.exe/,
  );

  const extra = new Map(good);
  extra.set("SimForge Studio-0.1.0-linux-amd64.deb", "1".repeat(64));
  await assert.rejects(() => collectInstallers({ dir, expectedSums: extra }), /was not found/);
});

test("a publication may not ship a partial platform set", async () => {
  const { "SimForge Studio-0.1.0-mac-x64.dmg": _dropped, ...withoutMacIntel } = FIXTURE;
  const dir = await installerFixture(withoutMacIntel);
  await assert.rejects(() => collectInstallers({ dir }), /covers no macos-x64 artifact/);
  const partial = await collectInstallers({ dir, requirePlatforms: false });
  assert.equal(partial.assets.length, 3);
});

test("two artifacts that normalize to one asset name are refused", async () => {
  const dir = await installerFixture({
    "SimForge Studio-0.1.0-linux-x86_64.AppImage": "a",
    "SimForge-Studio-0.1.0-linux-x86_64.AppImage": "b",
  });
  await assert.rejects(() => collectInstallers({ dir, requirePlatforms: false }), /both become the asset name/);
});

/** @param {{ publicallyReadable: boolean; channel?: string }} publication */
function releaseRecord({ publicallyReadable, channel = "preview" }) {
  return {
    tag: `studio-${channel === "preview" ? "preview.1" : "0.1.1"}`,
    distributionLabel: channel === "preview" ? "preview.1" : "0.1.1",
    embeddedVersion: "0.1.0",
    channel,
    source: { revision: "b102bcea" },
    cloud: { origin: "https://staging.simforge.ai" },
    releasePage: "",
    checksums: { file: "SHA256SUMS", url: "https://example.invalid/SHA256SUMS" },
    notices: { thirdParty: "https://example.invalid/THIRD_PARTY_NOTICES.md", correspondingSource: null },
    signing: { windows: "unsigned", macos: "ad-hoc", linux: "unsigned" },
    qualification: { interactivePlatforms: ["linux-x64"] },
    recordedAt: "2026-09-07T00:00:00.000Z",
    assets: [{ platform: "linux-x64", kind: "deb", assetName: "x.deb", originalFilename: "x.deb", url: "u", sha256: "c".repeat(64), sizeBytes: 1 }],
    publication: { state: publicallyReadable ? "released" : "draft", publicallyReadable },
  };
}

test("the download page only advertises a release anonymous users can fetch", () => {
  const draft = buildDownloadsManifest({ releases: [releaseRecord({ publicallyReadable: false })] });
  assert.equal(draft.channels.preview, null, "a draft is invisible to anonymous users; advertising it yields 404 links");
  assert.ok(draft.releases["studio-preview.1"], "the release record is still published for reference");

  const released = buildDownloadsManifest({ releases: [releaseRecord({ publicallyReadable: true })] });
  assert.equal(released.channels.preview, "studio-preview.1");
  assert.equal(released.channels.stable, null, "a preview never becomes the stable channel");

  const carried = buildDownloadsManifest({
    releases: [releaseRecord({ publicallyReadable: true, channel: "stable" })],
    previous: released,
  });
  assert.equal(carried.channels.preview, "studio-preview.1", "publishing stable keeps the preview pointer");
  assert.equal(carried.channels.stable, "studio-0.1.1");
});

/**
 * A real encoder-build receipt directory: a tools-manifest.json of the shape
 * build-encoders.mjs writes, next to an archive whose bytes actually hash to
 * the digest it records.
 * @param {(manifest: any) => void} [mutate]
 */
async function encoderReceiptFixture(mutate) {
  const dir = await mkdtemp(join(tmpdir(), "simforge-encoders-"));
  const { encodersLock } = await loadLedger(repoRoot);
  for (const [lockTarget, platform] of Object.entries({ "linux-x64": "linux-x64", "win32-x64": "windows-x64", "darwin-arm64": "macos-arm64", "darwin-x64": "macos-x64" })) {
    const targetDir = join(dir, platform, "corresponding-source");
    await mkdir(targetDir, { recursive: true });
    const archiveName = `simforge-studio-encoders-${lockTarget}-corresponding-source.tar.gz`;
    const bytes = `pretend source archive for ${lockTarget}`;
    await writeFile(join(targetDir, archiveName), bytes);
    const manifest = {
      schema: "simforge.desktop-tools/v2",
      target: lockTarget,
      origin: "built-from-source",
      builtAt: "2026-09-07T00:00:00.000Z",
      sources: encodersLock.sources.map((/** @type {any} */ entry) => ({ id: entry.id, commit: entry.commit })),
      tools: { ffmpeg: { file: "ffmpeg", sha256: "a".repeat(64), sizeBytes: 1 }, ffprobe: { file: "ffprobe", sha256: "b".repeat(64), sizeBytes: 1 } },
      correspondingSource: {
        file: `corresponding-source/${archiveName}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: Buffer.byteLength(bytes),
      },
    };
    mutate?.(manifest);
    await writeFile(join(dir, platform, "tools-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

test("GPL accompaniment clears only for a verified build receipt and a real archive", async () => {
  const blocked = await auditBundledComponents({ repoRoot });
  assert.equal(blocked.publicRedistribution, "blocked");
  assert.ok(
    blockingReasons(blocked, ["linux-x64"]).some((reason) => reason.includes("corresponding-source")),
    "with no receipts at all the obligation must block",
  );

  const receipts = await verifyEncoderReceipts({ repoRoot, dir: await encoderReceiptFixture() });
  assert.deepEqual(receipts.problems, []);
  assert.deepEqual(receipts.verified, ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
  const cleared = await auditBundledComponents({ repoRoot, encoderReceipts: receipts });
  assert.equal(cleared.publicRedistribution, "cleared", JSON.stringify(cleared.platforms, null, 2));
  assert.deepEqual(cleared.sourceDrift, []);
  assert.equal(blockingReasons(cleared, ["not-a-platform"]).length, 1, "an unaudited platform is blocked, not cleared");
});

test("a receipt is refused when the archive, the origin or the source commits do not hold", async () => {
  // An archive that does not hash to what the build recorded: a fixture
  // standing in for the real source must not clear the obligation.
  const tampered = await verifyEncoderReceipts({
    repoRoot,
    dir: await encoderReceiptFixture((manifest) => {
      manifest.correspondingSource.sha256 = "c".repeat(64);
    }),
  });
  assert.deepEqual(tampered.verified, []);
  assert.ok(tampered.problems.every((problem) => /does not hash to the digest/.test(problem)));
  const stillBlocked = await auditBundledComponents({ repoRoot, encoderReceipts: tampered });
  assert.equal(stillBlocked.publicRedistribution, "blocked");

  // Encoders that were downloaded rather than built.
  const notBuilt = await verifyEncoderReceipts({
    repoRoot,
    dir: await encoderReceiptFixture((manifest) => {
      manifest.origin = "downloaded";
    }),
  });
  assert.deepEqual(notBuilt.verified, []);
  assert.ok(notBuilt.problems.some((problem) => /not built from source/.test(problem)));

  // Built from a commit this repository does not pin.
  const otherSources = await verifyEncoderReceipts({
    repoRoot,
    dir: await encoderReceiptFixture((manifest) => {
      manifest.sources[0].commit = "d".repeat(40);
    }),
  });
  assert.deepEqual(otherSources.verified, []);
  assert.ok(otherSources.problems.some((problem) => /not the pinned/.test(problem)));

  // A missing archive.
  const missing = await verifyEncoderReceipts({
    repoRoot,
    dir: await encoderReceiptFixture((manifest) => {
      manifest.correspondingSource.file = "corresponding-source/absent.tar.gz";
    }),
  });
  assert.deepEqual(missing.verified, []);
  assert.ok(missing.problems.some((problem) => /is missing/.test(problem)));
});

test("repinning the encoder sources invalidates the license determination", async () => {
  const { components, encodersLock } = await loadLedger(repoRoot);
  const repinned = structuredClone(encodersLock);
  repinned.sources[0].commit = "f".repeat(40);
  const drift = sourceDrift(components, repinned);
  assert.deepEqual(
    drift.map((entry) => entry.source),
    ["ffmpeg"],
    "a build from other sources must not inherit the previous determination",
  );
});

test("stable gates fail closed on every unmeasured or unsigned property", () => {
  const unsigned = evaluateStableGates({
    label: "preview.1",
    embeddedVersion: "0.1.0",
    sourceRevision: "b102bcea",
    sourceReachableFromMain: false,
    cloudOrigin: "https://staging.simforge.ai",
    productionDesktopRoutes: null,
    signing: { windows: "unsigned", macos: "ad-hoc", linux: "unsigned" },
    interactivePlatforms: ["linux-x64"],
    licenseAudit: { publicRedistribution: "blocked", blockedPlatforms: ["macos-arm64"] },
    stack: null,
    updateCheckInBuild: null,
  });
  assert.equal(unsigned.verdict, "fail");
  const failed = new Set(unsigned.gates.filter((gate) => gate.status === "fail").map((gate) => gate.id));
  for (const id of [
    "label-is-a-version",
    "source-landed-on-main",
    "windows-authenticode",
    "macos-notarized",
    "installed-qualification-every-platform",
    "production-cloud-origin",
    "production-serves-desktop-routes",
    "license-obligations-cleared",
    "stack-identity-published",
    "cloud-vendor-lock-matches-source",
    "update-path-in-build",
  ]) {
    assert.ok(failed.has(id), `${id} should fail`);
  }

  const ready = evaluateStableGates({
    label: "0.1.1",
    embeddedVersion: "0.1.1",
    sourceRevision: "abc123",
    sourceReachableFromMain: true,
    cloudOrigin: "https://simforge.ai",
    productionDesktopRoutes: { connect: 200, session: 401 },
    signing: { windows: "authenticode", macos: "developer-id-notarized", linux: "unsigned" },
    interactivePlatforms: ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"],
    licenseAudit: { publicRedistribution: "cleared", blockedPlatforms: [] },
    stack: { stackVersion: "0.1.0-rc.62", tagged: true, published: true, vendorLockRevision: "abc123" },
    updateCheckInBuild: true,
  });
  assert.equal(ready.verdict, "pass");

  // Signing that is merely present is not notarization.
  const signedNotNotarized = evaluateStableGates({
    label: "0.1.1",
    embeddedVersion: "0.1.1",
    sourceRevision: "abc123",
    sourceReachableFromMain: true,
    cloudOrigin: "https://simforge.ai",
    productionDesktopRoutes: { connect: 200, session: 401 },
    signing: { windows: "authenticode", macos: "developer-id", linux: "unsigned" },
    interactivePlatforms: ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"],
    licenseAudit: { publicRedistribution: "cleared", blockedPlatforms: [] },
    stack: { stackVersion: "0.1.0-rc.62", tagged: true, published: true, vendorLockRevision: "abc123" },
    updateCheckInBuild: true,
  });
  assert.equal(signedNotNotarized.verdict, "fail");
});

const RELEASE_LIST = [
  { tag_name: "studio-0.1.1", prerelease: false, draft: false, published_at: "2026-10-01T00:00:00Z", html_url: "u1" },
  { tag_name: "studio-preview.2", prerelease: true, draft: false, published_at: "2026-09-20T00:00:00Z", html_url: "u2" },
  { tag_name: "studio-preview.3", prerelease: true, draft: true, published_at: "2026-11-01T00:00:00Z", html_url: "u3" },
  { tag_name: "v0.1.0-rc.61", prerelease: false, draft: false, published_at: "2026-12-01T00:00:00Z", html_url: "u4" },
];

test("a stable build is never offered a prerelease, and drafts are invisible", () => {
  assert.deepEqual(eligibleReleases(RELEASE_LIST, "stable").map((entry) => entry.tag), ["studio-0.1.1"]);
  // A preview build sees both: the stable release that follows it supersedes it.
  assert.deepEqual(
    eligibleReleases(RELEASE_LIST, "preview").map((entry) => entry.tag),
    ["studio-0.1.1", "studio-preview.2"],
  );
  assert.deepEqual(eligibleReleases("not a list", "preview"), []);
});

test("the downloads manifest is a usable update source when GitHub is not", () => {
  const manifest = {
    channels: { stable: null, preview: "studio-preview.1" },
    releases: { "studio-preview.1": { releasePage: "https://example.invalid/tag", generatedAt: "2026-09-07T00:00:00Z" } },
  };
  assert.deepEqual(manifestReleases(manifest, "preview").map((entry) => entry.tag), ["studio-preview.1"]);
  assert.deepEqual(manifestReleases(manifest, "stable"), [], "a stable build ignores the preview pointer");
});

test("an unlabelled build is recognized rather than assumed current", () => {
  assert.equal(readDistributionIdentity(undefined), null);
  assert.equal(readDistributionIdentity({ label: "preview.1" }), null, "a partial identity is no identity");
  assert.deepEqual(
    readDistributionIdentity({ label: "preview.1", channel: "preview", embeddedVersion: "0.1.0" }),
    { label: "preview.1", tag: "studio-preview.1", channel: "preview", embeddedVersion: "0.1.0" },
  );
  assert.equal(readDistributionIdentity({ label: "v1", channel: "stable", embeddedVersion: "1.0.0" }), null);
});

/** @param {Record<string, unknown>} routes */
function stubFetch(routes) {
  /** @type {string[]} */
  const requested = [];
  const impl = async (/** @type {string} */ url) => {
    requested.push(url);
    const answer = routes[new URL(url).host];
    if (answer === undefined) throw new Error(`unstubbed ${url}`);
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer };
  };
  return { impl, requested };
}

const PREVIEW_IDENTITY = { label: "preview.1", tag: "studio-preview.1", channel: "preview", embeddedVersion: "0.1.0" };

test("the update check compares against the newest release of its own channel", async () => {
  const { impl } = stubFetch({ "api.github.com": RELEASE_LIST });
  const behind = await checkForUpdates({ identity: PREVIEW_IDENTITY, userAgent: "t", fetch: impl });
  assert.equal(behind.state, "update-available");
  assert.equal(behind.latest?.tag, "studio-0.1.1");
  assert.equal(behind.source, "github");
  assert.match(describeUpdate(behind).detail, /not downloaded automatically/);

  const current = await checkForUpdates({
    identity: { ...PREVIEW_IDENTITY, label: "0.1.1", tag: "studio-0.1.1", channel: "stable", embeddedVersion: "0.1.1" },
    userAgent: "t",
    fetch: impl,
  });
  assert.equal(current.state, "current");
});

test("a rate-limited GitHub falls back to the product site's manifest", async () => {
  const manifest = {
    channels: { stable: null, preview: "studio-preview.1" },
    releases: { "studio-preview.1": { releasePage: "https://example.invalid/tag" } },
  };
  const { impl, requested } = stubFetch({
    "api.github.com": new Error("HTTP 403 rate limit exceeded"),
    "staging.simforge.ai": manifest,
  });
  const result = await checkForUpdates({
    identity: PREVIEW_IDENTITY,
    cloudOrigin: "https://staging.simforge.ai",
    userAgent: "t",
    fetch: impl,
  });
  assert.equal(result.source, "downloads-manifest");
  assert.equal(result.state, "current", "the manifest still advertises the installed release");
  assert.ok(requested.some((url) => url.endsWith("/download/releases.json")));

  const offline = await checkForUpdates({
    identity: PREVIEW_IDENTITY,
    cloudOrigin: null,
    userAgent: "t",
    fetch: stubFetch({ "api.github.com": new Error("getaddrinfo ENOTFOUND") }).impl,
  });
  assert.equal(offline.state, "unavailable");
  assert.equal(offline.latest, null);
  assert.match(describeUpdate(offline).detail, /Nothing was downloaded/);
});

test("an unlabelled build never reports itself up to date", async () => {
  const { impl } = stubFetch({ "api.github.com": RELEASE_LIST });
  const result = await checkForUpdates({ identity: null, userAgent: "t", fetch: impl });
  assert.equal(result.state, "unlabelled");
  assert.equal(result.latest?.tag, "studio-0.1.1", "it still offers the newest release to install");
  assert.match(describeUpdate(result).message, /cannot be compared/);
});
