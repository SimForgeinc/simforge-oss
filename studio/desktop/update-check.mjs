// Manual update check for the packaged shell.
//
// Deliberate limits, because this runs on a user's machine in a product with
// no telemetry:
//
//   * It runs only when the user picks Help › Check for Updates…. Nothing
//     here is scheduled, and the app makes no request on launch.
//   * It downloads nothing and installs nothing. The result is a release
//     name and a URL the user may open in the system browser. Automatic
//     download needs a signed Windows build and a notarized macOS build
//     (electron-updater refuses an unsigned app on macOS), which is a
//     business prerequisite, not a code one.
//   * It never invents a version comparison. Ordering comes from the
//     publication order of the release list, not from parsing labels: a
//     build asks "is the newest release of my channel the one I am?", which
//     is answerable, instead of "is 0.1.1 newer than preview.1?", which is
//     not.
//   * An unlabelled build (local stage, or a preview packaged before the
//     distribution identity was baked) reports exactly that and still offers
//     the newest release link, rather than claiming to be up to date.
//
// The GitHub releases API is unauthenticated (60 requests/hour/IP). When it
// is unavailable the check falls back to the downloads manifest the product
// site commits, and says which source answered.

import { CHANNEL_PRERELEASE, parseReleaseTag } from "./release-identity.mjs";

/** Where releases live. The repository is public; no credential is used. */
export const RELEASES_API = "https://api.github.com/repos/SimForgeinc/simforge-oss/releases?per_page=20";
export const RELEASES_PAGE = "https://github.com/SimForgeinc/simforge-oss/releases";
/** Path of the committed downloads manifest on the product site. */
export const DOWNLOADS_MANIFEST_PATH = "/download/releases.json";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ tag: string; label: string; channel: string; url: string; publishedAt: string | null }} PublishedRelease
 * @typedef {{
 *   state: "current" | "update-available" | "unlabelled" | "unavailable";
 *   source: "github" | "downloads-manifest" | "none";
 *   current: import("./release-identity.mjs").DistributionIdentity | null;
 *   latest: PublishedRelease | null;
 *   reason: string | null;
 * }} UpdateCheck
 */

/**
 * @param {string} url
 * @param {{ fetch: typeof globalThis.fetch; userAgent: string; accept: string }} options
 * @returns {Promise<unknown>}
 */
async function readJson(url, { fetch, userAgent, accept }) {
  const response = await fetch(url, {
    headers: { accept, "user-agent": userAgent, "x-github-api-version": "2022-11-28" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * Releases this build is allowed to be offered, newest first. A stable build
 * is never told about a prerelease; a preview build sees both, because a
 * preview is superseded by the stable release that follows it.
 * @param {unknown} payload the releases API response
 * @param {string} channel
 * @returns {PublishedRelease[]}
 */
export function eligibleReleases(payload, channel) {
  if (!Array.isArray(payload)) return [];
  const acceptsPrerelease = CHANNEL_PRERELEASE[channel] !== false;
  return payload
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = /** @type {Record<string, any>} */ (entry);
      const label = parseReleaseTag(record.tag_name);
      if (label === null || record.draft === true) return [];
      const prerelease = record.prerelease === true;
      if (prerelease && !acceptsPrerelease) return [];
      return [{
        tag: String(record.tag_name),
        label,
        channel: prerelease ? "preview" : "stable",
        url: typeof record.html_url === "string" ? record.html_url : `${RELEASES_PAGE}/tag/${record.tag_name}`,
        publishedAt: typeof record.published_at === "string" ? record.published_at : null,
      }];
    })
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));
}

/**
 * The channel pointers of the committed downloads manifest, newest channel
 * first for this build. The manifest is the site's own statement of what it
 * offers, so it is authoritative for "what would a new user download".
 * @param {unknown} payload
 * @param {string} channel
 * @returns {PublishedRelease[]}
 */
export function manifestReleases(payload, channel) {
  if (!payload || typeof payload !== "object") return [];
  const record = /** @type {Record<string, any>} */ (payload);
  const channels = record.channels && typeof record.channels === "object" ? record.channels : {};
  const releases = record.releases && typeof record.releases === "object" ? record.releases : {};
  const order = CHANNEL_PRERELEASE[channel] === false ? ["stable"] : ["stable", "preview"];
  return order.flatMap((name) => {
    const tag = channels[name];
    const label = parseReleaseTag(tag);
    if (label === null) return [];
    const release = releases[tag] ?? {};
    return [{
      tag,
      label,
      channel: name,
      url: typeof release.releasePage === "string" ? release.releasePage : `${RELEASES_PAGE}/tag/${tag}`,
      publishedAt: typeof release.generatedAt === "string" ? release.generatedAt : null,
    }];
  });
}

/**
 * @param {{
 *   identity: import("./release-identity.mjs").DistributionIdentity | null;
 *   cloudOrigin?: string | null;
 *   userAgent: string;
 *   fetch?: typeof globalThis.fetch;
 * }} options
 * @returns {Promise<UpdateCheck>}
 */
export async function checkForUpdates({ identity, cloudOrigin, userAgent, fetch = globalThis.fetch }) {
  const channel = identity?.channel ?? "preview";
  /** @type {string[]} */
  const failures = [];
  /** @type {{ source: "github" | "downloads-manifest"; releases: PublishedRelease[] } | null} */
  let answer = null;

  try {
    const payload = await readJson(RELEASES_API, { fetch, userAgent, accept: "application/vnd.github+json" });
    answer = { source: "github", releases: eligibleReleases(payload, channel) };
  } catch (error) {
    failures.push(`GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (answer === null && cloudOrigin) {
    try {
      const payload = await readJson(new URL(DOWNLOADS_MANIFEST_PATH, cloudOrigin).toString(), {
        fetch,
        userAgent,
        accept: "application/json",
      });
      answer = { source: "downloads-manifest", releases: manifestReleases(payload, channel) };
    } catch (error) {
      failures.push(`${cloudOrigin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (answer === null) {
    return { state: "unavailable", source: "none", current: identity ?? null, latest: null, reason: failures.join("; ") };
  }

  const latest = answer.releases[0] ?? null;
  if (identity === null) {
    return {
      state: "unlabelled",
      source: answer.source,
      current: null,
      latest,
      reason: "this build carries no distribution label, so it cannot be compared with a published release",
    };
  }
  if (latest === null) {
    return {
      state: "unavailable",
      source: answer.source,
      current: identity,
      latest: null,
      reason: `no ${channel} release is published`,
    };
  }
  return {
    state: latest.tag === identity.tag ? "current" : "update-available",
    source: answer.source,
    current: identity,
    latest,
    reason: null,
  };
}

/**
 * The exact words the shell shows. Kept beside the check so the states and
 * the copy cannot drift apart.
 * @param {UpdateCheck} result
 * @returns {{ message: string; detail: string; url: string | null }}
 */
export function describeUpdate(result) {
  const source = result.source === "downloads-manifest" ? "the SimForge downloads manifest" : "GitHub releases";
  const installed = result.current
    ? `Installed: ${result.current.label} (build ${result.current.embeddedVersion}, ${result.current.channel})`
    : "Installed: unlabelled build";
  switch (result.state) {
    case "current":
      return {
        message: "SimForge Studio is up to date.",
        detail: [installed, `${result.latest?.label ?? "?"} is the newest ${result.current?.channel ?? ""} release according to ${source}.`].join("\n"),
        url: result.latest?.url ?? null,
      };
    case "update-available":
      return {
        message: `SimForge Studio ${result.latest?.label} is available.`,
        detail: [
          installed,
          `Available: ${result.latest?.label} (${result.latest?.channel}) according to ${source}.`,
          "Updates are not downloaded automatically. Open the release page to read its notes and download the installer for this computer.",
        ].join("\n"),
        url: result.latest?.url ?? null,
      };
    case "unlabelled":
      return {
        message: "This build cannot be compared with published releases.",
        detail: [
          result.reason ?? "",
          result.latest ? `Newest published release: ${result.latest.label}.` : "",
          "Install a published release to receive update information.",
        ].filter(Boolean).join("\n"),
        url: result.latest?.url ?? RELEASES_PAGE,
      };
    default:
      return {
        message: "Could not check for updates.",
        detail: [installed, result.reason ?? "no source answered", "Nothing was downloaded. Try again later or open the releases page."].join("\n"),
        url: RELEASES_PAGE,
      };
  }
}
