// The one description of how a SimForge Studio distribution is named and
// identified. Shared by the release tooling (scripts/release/**) and by the
// packaged shell's update check, so a build can never disagree with the
// release that carries it.
//
// Three identities are deliberately distinct and never conflated:
//
//   embedded version    studio/package.json `version`, baked into the binary
//                       by electron-builder (`${version}` in every artifact
//                       name) and into the stage manifest as `studioVersion`.
//                       It describes the bytes.
//   distribution label  what a release is called to users ("preview.1",
//                       "0.1.1"). It describes the publication.
//   tag                 `studio-<label>`. It names the immutable Git commit
//                       the publication was built from.
//
// The first previews published binaries whose embedded version was 0.1.0 under
// labels like "preview.1"; those tags stay readable (parseReleaseTag). Every
// publication since sets the label equal to the embedded version, previews as
// prerelease semver ("0.1.10-preview.1"), because the background updater orders
// releases by semver and cannot place a generation name.
//
// The tag namespace matters operationally: `.github/workflows/publish.yml`
// triggers on `v*` and publishes the npm/PyPI stack. A desktop tag must
// never enter that namespace, or publishing an installer set would fire a
// stack publication of an unrelated tree.

/** Every desktop release tag starts with this; `v*` belongs to the stack. */
export const TAG_PREFIX = "studio-";

/** Release channels, in the order a newer channel may supersede an older one. */
export const CHANNELS = Object.freeze(["stable", "preview"]);

/** GitHub's flag per channel. A draft is a publication state, not a channel. */
export const CHANNEL_PRERELEASE = Object.freeze({ stable: false, preview: true });

/**
 * Labels are lowercase, start alphanumeric, and hold only `.`/`-` besides
 * alphanumerics, so `studio-<label>` is a valid Git ref and a safe URL and
 * file-name component. A leading `v` is refused: `studio-v1` reads as a stack
 * version and invites the collision the namespace exists to prevent.
 * @param {unknown} label
 * @returns {string}
 */
export function assertLabel(label) {
  if (typeof label !== "string" || !/^[0-9a-z][0-9a-z.-]*$/.test(label)) {
    throw new Error(`distribution label ${JSON.stringify(label)} must match /^[0-9a-z][0-9a-z.-]*$/`);
  }
  if (/^v[0-9]/.test(label)) throw new Error(`distribution label ${label} must not look like a stack version tag`);
  if (label.includes("..")) throw new Error(`distribution label ${label} must not contain ".."`);
  return label;
}

/** @param {string} label */
export function releaseTag(label) {
  return `${TAG_PREFIX}${assertLabel(label)}`;
}

/**
 * The label a tag carries, or null when the tag is not a desktop release tag.
 * Used to ignore the stack's `v*` tags when reading the release list.
 * @param {unknown} tag
 * @returns {string | null}
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX)) return null;
  const label = tag.slice(TAG_PREFIX.length);
  try {
    return assertLabel(label);
  } catch {
    return null;
  }
}

/** A label that names a version rather than a preview generation. */
const VERSION_LABEL = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.-]+)?$/;

/**
 * Refuse a publication whose label is not the version the bytes carry. Labels
 * are semver (prerelease for previews), so `studio-0.1.1` can only ever hold
 * 0.1.1 binaries and the updater can order what a channel offers.
 * @param {{ label: string; embeddedVersion: string }} identity
 */
export function assertLabelMatchesBuild({ label, embeddedVersion }) {
  assertLabel(label);
  if (typeof embeddedVersion !== "string" || embeddedVersion.length === 0) throw new Error("embeddedVersion is required");
  if (!VERSION_LABEL.test(label)) {
    throw new Error(`distribution label ${label} must be a semver version (preview labels use e.g. 0.1.10-preview.1)`);
  }
  if (label !== embeddedVersion) {
    throw new Error(`label ${label} names a version but the binaries embed ${embeddedVersion}; rebuild with studio/package.json set to the label`);
  }
}

/**
 * GitHub replaces every space in an uploaded asset name with a dot, which
 * silently breaks `SHA256SUMS` line matching and predictable download URLs.
 * The substitution is made here, deliberately and with a hyphen, before the
 * upload; nothing else about the file name changes, and in particular the
 * version token is never rewritten. The result must be a plain
 * `[A-Za-z0-9._-]` name — anything else means an artifact name this function
 * is not allowed to silently mangle.
 * @param {string} filename
 * @returns {string}
 */
export function safeAssetName(filename) {
  if (typeof filename !== "string" || filename.length === 0) throw new Error("filename is required");
  if (filename.includes("/") || filename.includes("\\")) throw new Error(`${filename}: asset names carry no path`);
  const safe = filename.replace(/\s+/g, "-");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safe)) {
    throw new Error(`${filename}: cannot be made a safe asset name (normalized to ${safe})`);
  }
  return safe;
}

/**
 * Which platform and installer kind a staged artifact is, decided from the
 * extension and the target token electron-builder puts in the name. Nothing
 * is inferred from the directory it was found in, so a misfiled artifact is
 * an error instead of a mislabelled download.
 * @param {string} filename
 * @returns {{ platform: string; kind: string }}
 */
export function classifyAsset(filename) {
  const name = filename.toLowerCase();
  if (name.endsWith(".exe")) return { platform: "windows-x64", kind: "nsis" };
  if (name.endsWith(".appimage")) return { platform: "linux-x64", kind: "appimage" };
  if (name.endsWith(".deb")) return { platform: "linux-x64", kind: "deb" };
  const mac = /-mac-(arm64|x64)\.(dmg|zip)$/.exec(name);
  if (mac) return { platform: `macos-${mac[1]}`, kind: mac[2] };
  throw new Error(`${filename}: not a recognized SimForge Studio installer artifact`);
}

/** Every platform a publication must cover before it may be offered at all. */
export const REQUIRED_PLATFORMS = Object.freeze(["windows-x64", "linux-x64", "macos-arm64", "macos-x64"]);

/**
 * The distribution identity a packaged build carries in its app
 * `package.json`, written by desktop/stage-app.mjs. Absent in an unlabelled
 * build (a local `desktop:stage`, or the sealed preview binaries that were
 * packaged before this field existed); the update check then says so instead
 * of comparing against a version it invented.
 * @typedef {{ label: string; tag: string; channel: string; embeddedVersion: string }} DistributionIdentity
 */

/**
 * @param {unknown} value the `simforgeDistribution` field of the app package.json
 * @returns {DistributionIdentity | null}
 */
export function readDistributionIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const label = typeof record.label === "string" ? parseReleaseTag(`${TAG_PREFIX}${record.label}`) : null;
  const channel = typeof record.channel === "string" && CHANNELS.includes(record.channel) ? record.channel : null;
  const embeddedVersion = typeof record.embeddedVersion === "string" ? record.embeddedVersion : null;
  if (!label || !channel || !embeddedVersion) return null;
  return { label, tag: releaseTag(label), channel, embeddedVersion };
}
