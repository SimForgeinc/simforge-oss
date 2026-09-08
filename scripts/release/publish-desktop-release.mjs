#!/usr/bin/env node
// Publish a SimForge Studio installer set as a GitHub release, repeatably.
//
//   # prepare and inspect; touches nothing remote (the default)
//   node scripts/release/publish-desktop-release.mjs \
//     --label preview.1 --channel preview \
//     --installers /mnt/storage/simforge-native-migration/ci-release-b102 \
//     --sums /mnt/storage/simforge-native-migration/ci-release-b102/SHA256SUMS \
//     --source-revision b102bceac7b7af0df43b7695c60c4be526753805 \
//     --cloud-origin https://staging.simforge.ai \
//     --signing-windows unsigned --signing-macos ad-hoc --signing-linux unsigned \
//     --interactive linux-x64 --ci-run 34143594031 --out artifacts/release/studio-preview.1
//
//   # create the release as a maintainers-only draft
//   … --publish draft --confirm
//
//   # make it publicly downloadable (requires a cleared license audit)
//   … --publish release --confirm
//
// Guarantees, in the code rather than in a runbook:
//
//   * The bytes are CI's. Digests are verified against the checksum file that
//     travelled with the installers before anything is uploaded, and again
//     from GitHub's own reported asset digests afterwards.
//   * Names are normalized exactly once, by substituting a hyphen for the
//     space GitHub would replace with a dot. The version token is untouched,
//     so a preview of 0.1.0 binaries stays a 0.1.0 build under a preview
//     label.
//   * The tag lives in the `studio-*` namespace, never `v*`: a desktop
//     publication cannot trigger the stack's npm/PyPI workflow.
//   * A publicly readable release requires every published platform to be
//     cleared by the license audit. Blocked platforms may only ever reach a
//     draft, and the tool says which obligation blocked them.
//   * `--channel stable` additionally requires a measurements file whose
//     gates all pass (scripts/release/stable-gates.mjs). There is no flag
//     that asserts a build is signed.
//   * Nothing remote happens without --confirm.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { CHANNEL_PRERELEASE, REQUIRED_PLATFORMS, releaseTag } from "../../studio/desktop/release-identity.mjs";
import {
  NOTICES_FILE,
  RELEASE_FILE,
  REPOSITORY,
  SUMS_FILE,
  buildDownloadsManifest,
  buildReleaseRecord,
  collectInstallers,
  collectSumsFiles,
  embeddedVersionOf,
  assetUrl,
  formatSums,
  parseSums,
  releasePageUrl,
  renderReleaseNotes,
  signingFromArtifactDirs,
  sumsFromReleaseRecord,
} from "./desktop-release-lib.mjs";
import { LOCK_TARGET_PLATFORM, auditBundledComponents, blockingReasons, loadLedger, renderThirdPartyNotices, verifyEncoderReceipts } from "./third-party-audit-lib.mjs";
import { readdir } from "node:fs/promises";
import { evaluateStableGates } from "./stable-gates.mjs";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES_FILE = "release-notes.md";
const AUDIT_FILE = "license-audit.json";
const DOWNLOADS_FILE = "releases.json";
const GATES_FILE = "stable-gates.json";

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[arg.slice(2)] = true;
    else {
      args[arg.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

/** @param {Record<string, string | boolean>} args @param {string} name */
function required(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
  return value;
}

/** @param {string[]} command */
async function git(command) {
  const { stdout } = await run("git", ["-C", repoRoot, ...command]);
  return stdout.trim();
}

/**
 * Does the built revision contain the manual update check? A stable release
 * without it strands its users on that version with no way to learn about
 * the next one.
 * @param {string} revision
 */
async function revisionHasUpdateCheck(revision) {
  try {
    await git(["cat-file", "-e", `${revision}:studio/desktop/update-check.mjs`]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} revision */
/**
 * Were these installers built from a revision that builds its own encoders?
 *
 * This matters more than it looks. The license ledger describes the encoders
 * desktop/build-encoders.mjs produces from pinned sources. Artifacts built
 * before that existed carry third-party prebuilt binaries instead — including
 * a macOS arm64 ffmpeg configured --enable-nonfree, which may not be
 * redistributed at all. Publishing such a set would attach an audit that
 * describes bytes the package does not contain, so it is refused outright.
 * @param {string} revision
 */
async function revisionBuildsItsOwnEncoders(revision) {
  try {
    await git(["cat-file", "-e", `${revision}:studio/desktop/build-encoders.mjs`]);
    return true;
  } catch {
    return false;
  }
}

async function revisionReachableFromMain(revision) {
  for (const ref of ["origin/main", "main"]) {
    try {
      await git(["merge-base", "--is-ancestor", revision, ref]);
      return true;
    } catch (error) {
      const failure = /** @type {{ code?: number }} */ (error);
      if (failure.code === 1) return false;
    }
  }
  return null;
}

/** The stack identity the installers were built beside. */
async function stackIdentity() {
  const path = join(repoRoot, "config/simforge-oss-stack.json");
  const raw = await readFile(path, "utf8");
  return {
    stackVersion: JSON.parse(raw).stackVersion,
    stackConfigSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

/** @param {string[]} argv */
async function gh(argv) {
  const { stdout } = await run("gh", argv, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * GitHub's own view of what it stored. Reported digests must equal the ones
 * we uploaded, or the release is not the installer set we verified.
 * @param {string} tag
 * @param {{ assetName: string; sha256: string; sizeBytes: number }[]} expected
 */
async function verifyUploadedAssets(tag, expected) {
  // A draft release has no git tag until it is published, so
  // /releases/tags/<tag> answers 404 for exactly the case this tool creates
  // first. The release list carries drafts and their assets, so the release
  // is found by its tag_name there and verification works before publication
  // rather than only after it.
  const releases = JSON.parse(await gh(["api", "--paginate", `repos/${REPOSITORY}/releases`]));
  const payload = releases.find((/** @type {any} */ release) => release.tag_name === tag);
  if (!payload) throw new Error(`no release found for ${tag} after creating it`);
  const assets = new Map(
    (payload.assets ?? []).map((/** @type {any} */ asset) => [asset.name, asset]),
  );
  /** @type {string[]} */
  const problems = [];
  for (const entry of expected) {
    const asset = assets.get(entry.assetName);
    if (!asset) {
      problems.push(`${entry.assetName} is not attached to ${tag}`);
      continue;
    }
    if (asset.size !== entry.sizeBytes) {
      problems.push(`${entry.assetName}: GitHub stored ${asset.size} bytes, expected ${entry.sizeBytes}`);
    }
    const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : null;
    if (digest && digest !== entry.sha256) {
      problems.push(`${entry.assetName}: GitHub reports sha256 ${digest}, expected ${entry.sha256}`);
    }
    if (asset.state !== "uploaded") problems.push(`${entry.assetName}: state ${asset.state}`);
  }
  return { problems, releaseId: payload.id, url: payload.html_url };
}

/**
 * The GPL corresponding-source archives found beside a set of installers,
 * one per platform. Their names carry the target they belong to, which is
 * what build-encoders.mjs writes them as.
 * @param {string} dir
 * @returns {Promise<{ platform: string; path: string; assetName: string }[]>}
 */
async function collectCorrespondingSource(dir) {
  /** @type {{ platform: string; path: string; assetName: string }[]} */
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^simforge-studio-encoders-([a-z0-9-]+)-corresponding-source\.tar\.gz$/.exec(entry.name);
    if (!match) continue;
    const platform = LOCK_TARGET_PLATFORM[match[1]];
    if (!platform) continue;
    found.push({ platform, path: join(entry.parentPath ?? dir, entry.name), assetName: entry.name });
  }
  return found;
}

/**
 * The installers a CI run produced, downloaded into `dir`. `gh run download`
 * writes one subdirectory per artifact, which is exactly the shape
 * collectInstallers walks.
 * @param {string} runId
 * @param {string} dir
 */
async function downloadRunArtifacts(runId, dir) {
  await mkdir(dir, { recursive: true });
  await gh(["run", "download", runId, "--repo", REPOSITORY, "--dir", dir]);
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = required(args, "label");
  const channel = typeof args.channel === "string" ? args.channel : "preview";
  if (!Object.hasOwn(CHANNEL_PRERELEASE, channel)) throw new Error(`--channel must be preview or stable`);
  const publish = typeof args.publish === "string" ? args.publish : "none";
  if (!["none", "draft", "release"].includes(publish)) throw new Error("--publish must be none, draft or release");
  const confirm = args.confirm === true;
  const outDir = resolve(typeof args.out === "string" ? args.out : join("artifacts/release", releaseTag(label)));
  // Installers come either from a directory (the qualified local mirror) or
  // straight from the CI run that built them, which is what makes the
  // publication repeatable once the run's artifacts are the only copy left.
  const installersDir = typeof args["from-run"] === "string"
    ? await downloadRunArtifacts(args["from-run"], join(outDir, "installers"))
    : resolve(required(args, "installers"));
  const sourceRevision = typeof args["source-revision"] === "string"
    ? args["source-revision"]
    : await git(["rev-parse", "HEAD"]);
  const tag = releaseTag(label);

  // 1. The installer set, proven identical to what CI produced. The digests
  //    may come from the checksum files each packaging leg recorded, from a
  //    previously written release record, or from an explicit file — but for
  //    a publication they must come from somewhere.
  const expectedSums = typeof args.sums === "string"
    ? parseSums(await readFile(args.sums, "utf8"))
    : typeof args["expect-release"] === "string"
      ? sumsFromReleaseRecord(JSON.parse(await readFile(args["expect-release"], "utf8")))
      : args["sums-from-installers"] === true
        ? await collectSumsFiles(installersDir)
        : null;
  // Full platform coverage is the default and the silent gap is refused. An
  // interim publication for fewer platforms has to say so out loud:
  // --platforms names exactly the set being published, the record carries
  // platformSet "partial", and the notes disclose which platforms are absent
  // so nobody reads a missing target as a broken one.
  const declaredPlatforms = typeof args.platforms === "string"
    ? args.platforms.split(",").map((entry) => entry.trim()).filter(Boolean)
    : null;
  const { assets, verifiedAgainstSums } = await collectInstallers({
    dir: installersDir,
    expectedSums,
    requirePlatforms: declaredPlatforms === null,
  });
  if (!verifiedAgainstSums && publish !== "none") {
    throw new Error(
      "publishing requires the uploaded bytes to be verified: pass --sums <file>, --expect-release <RELEASE.json> or --sums-from-installers",
    );
  }
  const platforms = [...new Set(assets.map((asset) => asset.platform))].sort();
  if (declaredPlatforms !== null) {
    // The declaration is checked against the bytes in both directions, so
    // --platforms can neither hide a platform that is present nor promise one
    // that is missing.
    const declared = [...new Set(declaredPlatforms)].sort();
    if (declared.join(",") !== platforms.join(",")) {
      throw new Error(`--platforms names ${declared.join(", ")} but the installer set covers ${platforms.join(", ")}`);
    }
  }

  // 2. The GPL corresponding source that must accompany the binaries. CI
  //    uploads one archive per packaging leg beside the installers; a local
  //    set can point at a directory instead. Publishing without them is
  //    refused below, because GPL-3.0 section 6 accompaniment is a shipped
  //    archive, not an intention.
  const correspondingSource = await collectCorrespondingSource(
    typeof args["corresponding-source"] === "string" ? resolve(args["corresponding-source"]) : installersDir,
  );

  // 3. What the third-party payload obliges us to do.
  // The receipts CI wrote beside the installers, verified here: manifest
  // schema, built-from-source origin, source commits equal to this
  // repository's pins, and an archive whose bytes hash to the digest the
  // build recorded. Only these clear the GPL accompaniment obligation.
  const encoderReceipts = await verifyEncoderReceipts({
    repoRoot,
    dir: typeof args["corresponding-source"] === "string" ? resolve(args["corresponding-source"]) : installersDir,
  });
  const audit = await auditBundledComponents({ repoRoot, platforms, encoderReceipts });
  const { components } = await loadLedger(repoRoot);
  const blocked = blockingReasons(audit, platforms);

  // 4. The embedded version, read from the artifacts rather than asserted.
  const embeddedVersion = embeddedVersionOf(assets);

  // Signing is read from the labels CI gave the artifacts whenever the
  // installers came from a run; flags are only for a hand-assembled set, and
  // a stable release cannot be declared from flags because the gates demand
  // the notarized state that only CI's own labelling produces.
  const signing = args["signing-from-artifacts"] === true
    ? await signingFromArtifactDirs(installersDir)
    : {
      windows: typeof args["signing-windows"] === "string" ? args["signing-windows"] : "unsigned",
      macos: typeof args["signing-macos"] === "string" ? args["signing-macos"] : "ad-hoc",
      linux: typeof args["signing-linux"] === "string" ? args["signing-linux"] : "unsigned",
    };

  const stack = await stackIdentity();
  const record = buildReleaseRecord({
    label,
    channel,
    embeddedVersion,
    source: {
      revision: sourceRevision,
      branch: typeof args["source-branch"] === "string" ? args["source-branch"] : null,
      treeSha256: typeof args["source-tree-sha256"] === "string" ? args["source-tree-sha256"] : null,
    },
    cloud: {
      origin: required(args, "cloud-origin"),
      revision: typeof args["cloud-revision"] === "string" ? args["cloud-revision"] : null,
    },
    stack: {
      ...stack,
      vendorLockRevision: typeof args["vendor-lock-revision"] === "string" ? args["vendor-lock-revision"] : null,
      published: args["stack-published"] === true,
    },
    signing,
    assets,
    audit,
    qualification: {
      interactivePlatforms: typeof args.interactive === "string" ? args.interactive.split(",").map((entry) => entry.trim()) : [],
      packagingVerified: platforms,
      evidence: typeof args.evidence === "string" ? args.evidence.split(",").map((entry) => entry.trim()) : [],
      platformSet: declaredPlatforms === null ? "complete" : "partial",
      platformsAbsent: declaredPlatforms === null
        ? []
        : ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"].filter((platform) => !platforms.includes(platform)),
    },
    ci: typeof args["ci-run"] === "string"
      ? { runId: Number(args["ci-run"]), url: `https://github.com/${REPOSITORY}/actions/runs/${args["ci-run"]}` }
      : null,
    publication: { state: publish === "release" ? "released" : publish === "draft" ? "draft" : "prepared", publicallyReadable: false },
  });

  // 4. What this publication is allowed to be.
  /** @type {string[]} */
  const refusals = [];
  let gates = null;
  if (channel === "stable") {
    if (typeof args.measurements !== "string") {
      refusals.push("--channel stable requires --measurements <file.json>; see scripts/release/stable-gates.mjs");
    } else {
      gates = evaluateStableGates(JSON.parse(await readFile(args.measurements, "utf8")));
      if (gates.verdict !== "pass") {
        refusals.push(...gates.gates.filter((gate) => gate.status === "fail").map((gate) => `stable gate ${gate.id}: ${gate.detail}`));
      }
    }
  }
  const sourceBuiltEncoders = await revisionBuildsItsOwnEncoders(sourceRevision);
  if (!sourceBuiltEncoders) {
    refusals.push(
      `${sourceRevision} predates studio/desktop/build-encoders.mjs, so these installers bundle third-party prebuilt encoders ` +
        "(the macOS arm64 one is an --enable-nonfree ffmpeg that may not be redistributed) and the license audit does not describe them: " +
        "rebuild the installer set from a revision that builds its own encoders",
    );
  }

  // Bytes nobody may redistribute are not uploaded at all — not even to a
  // draft, which lives in the public repository and can be published with one
  // click. This is separate from the paperwork obligations below.
  const prohibited = audit.obligations
    .filter((entry) => entry.kind === "redistribution-permission" && !["satisfied", "not-applicable"].includes(entry.status))
    .flatMap((entry) => entry.platforms.map((platform) => `${platform}: ${entry.component} may not be redistributed (${entry.status})`));
  if (prohibited.length > 0) {
    refusals.push(...prohibited);
  }
  if (publish === "release" && blocked.length > 0) {
    refusals.push(...blocked.map((reason) => `unresolved third-party obligation — ${reason}`));
  }
  const missingPlatforms = REQUIRED_PLATFORMS.filter((platform) => !platforms.includes(platform));
  if (publish === "release" && missingPlatforms.length > 0) {
    refusals.push(`no installer for ${missingPlatforms.join(", ")}`);
  }
  const canPublishPublicly = publish === "release" && refusals.length === 0;
  record.publication = {
    state: canPublishPublicly ? "released" : publish === "none" ? "prepared" : "draft",
    publicallyReadable: canPublishPublicly,
  };

  // 5. The documents that travel with the bytes.
  const notices = renderThirdPartyNotices({ receipt: audit, components, release: { tag, sourceRevision } });
  record.notices.correspondingSource = correspondingSource.length > 0
    ? correspondingSource.map((entry) => ({ platform: entry.platform, url: assetUrl(tag, entry.assetName) }))
    : null;
  const notes = renderReleaseNotes({ release: record, audit });
  const sums = formatSums(record.assets);
  const downloads = buildDownloadsManifest({
    releases: [record],
    previous: typeof args["previous-downloads"] === "string"
      ? JSON.parse(await readFile(args["previous-downloads"], "utf8"))
      : null,
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, RELEASE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(outDir, SUMS_FILE), sums);
  await writeFile(join(outDir, NOTICES_FILE), notices);
  await writeFile(join(outDir, NOTES_FILE), notes);
  await writeFile(join(outDir, AUDIT_FILE), `${JSON.stringify(audit, null, 2)}\n`);
  await writeFile(join(outDir, DOWNLOADS_FILE), `${JSON.stringify(downloads, null, 2)}\n`);
  if (gates) await writeFile(join(outDir, GATES_FILE), `${JSON.stringify(gates, null, 2)}\n`);

  const plan = {
    component: "simforge-desktop-release",
    event: publish === "none" || !confirm ? "release.prepared" : "release.publishing",
    tag,
    channel,
    distributionLabel: label,
    embeddedVersion,
    sourceRevision,
    platforms,
    assets: record.assets.length,
    licenseAudit: audit.publicRedistribution,
    correspondingSource: encoderReceipts.verified,
    encoderReceiptProblems: encoderReceipts.problems,
    blockedPlatforms: audit.blockedPlatforms,
    publication: record.publication,
    refusals,
    updateCheckInBuild: await revisionHasUpdateCheck(sourceRevision),
    sourceBuiltEncoders,
    sourceReachableFromMain: await revisionReachableFromMain(sourceRevision),
    out: outDir,
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (publish === "none") return 0;
  if (prohibited.length > 0 || !sourceBuiltEncoders) {
    process.stderr.write(
      `refusing to upload ${tag} anywhere, including as a draft:\n  ${[...prohibited, ...(sourceBuiltEncoders ? [] : refusals.slice(0, 1))].join("\n  ")}\n` +
        "Rebuild the affected leg with redistributable components before publishing.\n",
    );
    return 2;
  }
  if (refusals.length > 0 && publish === "release") {
    process.stderr.write(
      `refusing to publish ${tag} publicly:\n  ${refusals.join("\n  ")}\n` +
        "Publish it as a draft (--publish draft) and resolve the obligations above.\n",
    );
    return 2;
  }
  if (!confirm) {
    process.stderr.write(`add --confirm to create ${tag} on ${REPOSITORY}\n`);
    return 0;
  }

  // 6. Create as a draft, upload, verify GitHub's stored digests, and only
  //    then — if allowed — make it publicly readable. A release is never
  //    visible before its assets are proven complete.
  const existing = await gh(["release", "view", tag, "--repo", REPOSITORY, "--json", "id"]).catch(() => null);
  if (existing === null) {
    await gh([
      "release", "create", tag,
      "--repo", REPOSITORY,
      "--target", sourceRevision,
      "--title", `SimForge Studio ${label} (build ${embeddedVersion})`,
      "--notes-file", join(outDir, NOTES_FILE),
      "--draft",
      ...(CHANNEL_PRERELEASE[channel] ? ["--prerelease"] : []),
    ]);
  } else {
    await gh(["release", "edit", tag, "--repo", REPOSITORY, "--notes-file", join(outDir, NOTES_FILE)]);
  }

  const uploads = [
    ...assets.map((asset) => join(installersDir, asset.sourcePath)),
    ...correspondingSource.map((entry) => entry.path),
    join(outDir, SUMS_FILE),
    join(outDir, RELEASE_FILE),
    join(outDir, NOTICES_FILE),
  ];
  // Republishing the same label from a NEWER source must not leave a single
  // byte of the older one attached. --clobber only replaces same-named files,
  // so an asset whose name changed, or a platform dropped from the set, would
  // otherwise survive and the release would be a mixture of two revisions
  // described by one manifest. Anything not in the intended set is deleted
  // first.
  const intended = new Set(uploads.map((file) => {
    const match = assets.find((candidate) => basename(candidate.sourcePath) === basename(file));
    return match ? match.assetName : basename(file);
  }));
  const attached = JSON.parse(await gh(["api", "--paginate", `repos/${REPOSITORY}/releases`]))
    .find((/** @type {any} */ release) => release.tag_name === tag)?.assets ?? [];
  for (const asset of attached) {
    if (intended.has(asset.name)) continue;
    process.stdout.write(`${JSON.stringify({ component: "simforge-desktop-release", event: "asset.stale-removed", asset: asset.name })}\n`);
    await gh(["api", "--method", "DELETE", `repos/${REPOSITORY}/releases/assets/${asset.id}`]);
  }
  for (const file of uploads) {
    const asset = assets.find((candidate) => basename(candidate.sourcePath) === basename(file));
    // GitHub derives the asset name from the file name; upload under the
    // normalized name so the checksum file and the URLs match what we wrote.
    const uploadName = asset ? asset.assetName : basename(file);
    await gh(["release", "upload", tag, `${file}#${uploadName}`, "--repo", REPOSITORY, "--clobber"]);
  }

  // Everything uploaded is verified, documents included: a truncated
  // THIRD_PARTY_NOTICES.md on a public release is a missing license notice,
  // not a cosmetic defect.
  const documents = [
    { assetName: SUMS_FILE, text: sums },
    { assetName: RELEASE_FILE, text: `${JSON.stringify(record, null, 2)}\n` },
    { assetName: NOTICES_FILE, text: notices },
  ].map((document) => ({
    assetName: document.assetName,
    sha256: createHash("sha256").update(document.text).digest("hex"),
    sizeBytes: Buffer.byteLength(document.text),
  }));
  const verification = await verifyUploadedAssets(tag, [...record.assets, ...documents]);
  if (verification.problems.length > 0) {
    process.stderr.write(`release ${tag} is incomplete; it stays a draft:\n  ${verification.problems.join("\n  ")}\n`);
    return 2;
  }

  if (canPublishPublicly) {
    await gh([
      "release", "edit", tag,
      "--repo", REPOSITORY,
      "--draft=false",
      `--prerelease=${CHANNEL_PRERELEASE[channel]}`,
      `--latest=${channel === "stable"}`,
    ]);
  }

  process.stdout.write(`${JSON.stringify({
    component: "simforge-desktop-release",
    event: "release.published",
    tag,
    publication: record.publication,
    releaseId: verification.releaseId,
    page: releasePageUrl(tag),
    assetsVerified: record.assets.length + documents.length,
  }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
