#!/usr/bin/env node
// Stages the SimCloud-connected desktop application.
//
//   node desktop/stage-cloud.mjs [--origin=https://simforge.ai]
//
// Produces studio/dist/desktop-cloud/app: the shell bundled in cloud mode
// with the origin baked in, the cache preload, its static pages and a
// dependency-free package.json (desktop/stage-app.mjs). That is the whole
// artifact: no local host, no Next standalone output, no native addon or
// runtime archive, so the same stage packages on Windows, macOS and Linux
// (desktop/electron-builder.cloud.yml) and never carries Linux binaries.
// Maps are never bundled; they stream into the on-disk cache at runtime.
//
// The origin must be https://, or http:// on loopback for local qualification
// (the packaged app applies the same rule to a runtime SIMCLOUD_ORIGIN).

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLOUD_ORIGIN, stageApp } from "./stage-app.mjs";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, "..");
const appDir = join(studioRoot, "dist", "desktop-cloud", "app");

/** @param {string} raw */
function normalizeOrigin(raw) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--origin is not a URL: ${raw}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`--origin must be https:// (http:// only on loopback): ${raw}`);
  }
  return url.origin;
}

const originArg = process.argv.find((arg) => arg.startsWith("--origin="))?.slice("--origin=".length)
  ?? process.env.SIMCLOUD_ORIGIN
  ?? DEFAULT_CLOUD_ORIGIN;
const origin = normalizeOrigin(originArg);
const studioPackage = JSON.parse(await readFile(join(studioRoot, "package.json"), "utf8"));

const application = await stageApp({
  appDir,
  mode: "cloud",
  origin,
  version: studioPackage.version,
  license: studioPackage.license,
});

process.stdout.write(`${JSON.stringify({
  component: "simforge-desktop-stage",
  event: "stage-cloud.complete",
  app: appDir,
  origin,
  appFiles: application.files,
  platform: "any",
})}\n`);
