// The local host of an installed desktop artifact.
//
// `desktop/stage.mjs` bundles this file to `<stage>/studio/host/host-main.mjs`
// and starts it through the one-line launcher `<stage>/studio/host/host.mjs`
// so `process.argv[1]` never equals a bundled module's `import.meta.url`: the
// self-run guards of the bundled `scripts/migrate.ts` and `scripts/seed.ts`
// stay false and the supervisor alone decides when they run. The stage root
// mirrors the repository layout (`<stage>/studio`, `<stage>/packages`), so
// repository-relative asset lookups inside the bundle resolve to staged
// copies. The interpreter is whatever launched this file; under the desktop
// shell that is Electron in Node mode.
//
// The stage is read-only (an installed application). Everything that is
// written at runtime — database, artifacts, map cache, native job state — lives
// under the data root the shell chose (`SIMFORGE_CLOUD_ROOT`), never here.

import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localHostConfig, runLocalHost, type LocalHostPlan } from "../scripts/local-host";
import { assertStagePlatform, readStageManifest } from "./stage-manifest.mjs";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = resolve(studioRoot, "..");
const manifest = await readStageManifest(stageRoot);
assertStagePlatform(manifest);

// Bundled code cannot locate package-relative binaries and assets; the
// staged copies are named here through the documented overrides. Explicit
// settings from the environment win, so a developer build stays selectable.
const staged = (rel: string) => resolve(stageRoot, rel);
process.env.SIMFORGE_NATIVE_RUNTIME_ADDON ||= staged(manifest.nativeAddon);
process.env.SIMFORGE_NATIVE_RUNTIME_ROOT ||= staged(manifest.nativeRuntimeRoot);
process.env.SIMFORGE_RUNNER_BIN ||= staged(manifest.nativeRunner);
process.env.SIMFORGE_NATIVE_RENDER_BINARY ||= staged(manifest.nativeRenderService);
process.env.SIMFORGE_FFMPEG_BINARY ||= staged(manifest.tools.ffmpeg);
process.env.SIMFORGE_FFPROBE_BINARY ||= staged(manifest.tools.ffprobe);
process.env.SIMFORGE_ACTOR_ASSETS_ROOT ||= staged(manifest.actorAssetsRoot);
process.env.SIMFORGE_BROWSER_HARNESS_URL ||= pathToFileURL(staged(manifest.browserHarness)).href;
// Bare `ffmpeg`/`ffprobe` spawns resolve to the bundled encoders before anything on the machine.
process.env.PATH = [dirname(staged(manifest.tools.ffmpeg)), process.env.PATH ?? ""].filter(Boolean).join(delimiter);

const config = localHostConfig();
const plan: LocalHostPlan = {
  server: { command: process.execPath, args: [staged(manifest.server)], cwd: studioRoot },
  worker: { command: process.execPath, args: [staged(manifest.workerEntry)], cwd: studioRoot },
};
process.exit(await runLocalHost(plan, config));
