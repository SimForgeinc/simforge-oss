// Background application updates for the packaged shell, on the standard
// electron-updater path: a per-channel feed of update-info files, background
// differential download, install on restart.
//
// What is deliberately NOT here:
//
//   * macOS. Squirrel.Mac validates an update against the running app's code
//     signature and rejects the ad-hoc identity our Mac builds carry (see
//     .github/workflows/desktop.yml). Until a Developer ID identity exists the
//     Mac shell keeps the manual Help › Check for Updates… of update-check.mjs,
//     which downloads nothing.
//   * Unlabelled builds. A local stage has no distribution identity and so no
//     channel; it cannot know which feed describes it.
//   * A configurable feed URL. The feed is a function of the channel baked into
//     the package at stage time (scripts/release/publish-desktop-release.mjs
//     writes the matching files), so a build cannot be pointed at a foreign feed.

import { app } from "electron";
import electronUpdater from "electron-updater";

// CommonJS package: the named form only works when Node's CJS lexer sees it, not under a loader (dev).
const { autoUpdater } = electronUpdater;
import { CHANNELS } from "./release-identity.mjs";

/** Owner/repository the versioned releases and the channel feeds live under. */
const REPOSITORY = "SimForgeinc/simforge-oss";

/**
 * The rolling release that carries a channel's update-info files. Every entry
 * in those files is an absolute URL to an immutable asset of a versioned
 * `studio-<label>` release; only the pointer files move.
 * @param {string} channel
 */
export function feedUrlForChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown update channel ${channel}`);
  return `https://github.com/${REPOSITORY}/releases/download/studio-channel-${channel}/`;
}

/**
 * electron-updater fetches `<channel>[-mac|-linux].yml`, except that the
 * default channel is spelled `latest`. The publish script names the files the
 * same way (desktop-release-lib feedFilesFor).
 * @param {string} channel
 */
export function feedChannelName(channel) {
  return channel === "stable" ? "latest" : channel;
}

/**
 * @param {{ channel: string | null; onState?: (state: string, detail?: string) => void }} options
 * @returns {{ enabled: false; reason: string } | { enabled: true; check: () => Promise<unknown>; install: () => void }}
 */
export function configureAutoUpdater({ channel, onState = () => {} }) {
  if (!app.isPackaged) return { enabled: false, reason: "unpackaged build" };
  if (process.platform === "darwin") return { enabled: false, reason: "macOS builds are not signed with a Developer ID identity" };
  if (!channel) return { enabled: false, reason: "unlabelled build has no channel" };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = channel !== "stable";
  autoUpdater.channel = feedChannelName(channel);
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrlForChannel(channel), channel: feedChannelName(channel) });
  autoUpdater.on("checking-for-update", () => onState("checking"));
  autoUpdater.on("update-available", (info) => onState("available", info.version));
  autoUpdater.on("update-not-available", () => onState("current"));
  autoUpdater.on("download-progress", (progress) => onState("downloading", `${Math.round(progress.percent)}%`));
  autoUpdater.on("update-downloaded", (info) => onState("ready", info.version));
  autoUpdater.on("error", (error) => onState("error", error instanceof Error ? error.message : String(error)));
  return {
    enabled: true,
    check: () => autoUpdater.checkForUpdates(),
    install: () => autoUpdater.quitAndInstall(),
  };
}
