// The local host of an installed desktop artifact.
//
// `desktop/stage.mjs` bundles this file to `<stage>/studio/host/host-main.mjs`
// and starts it through the one-line launcher `<stage>/studio/host/host.mjs`
// so `process.argv[1]` never equals a bundled module's `import.meta.url`: the
// self-run guards of the bundled `scripts/migrate.ts` and `scripts/seed.ts`
// stay false and the supervisor alone decides when they run. The stage root
// mirrors the repository layout (`<stage>/studio`, `<stage>/packages`,
// `<stage>/fixtures`), so repository-relative asset lookups inside the bundle
// resolve to staged copies. The interpreter is whatever launched this file;
// under the desktop shell that is Electron in Node mode.

import { dirname, resolve } from "node:path";
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
process.env.SIMFORGE_NATIVE_RUNTIME_ADDON ||= resolve(stageRoot, manifest.nativeAddon);
process.env.SIMFORGE_NATIVE_RUNTIME_ROOT ||= resolve(stageRoot, manifest.nativeRuntimeRoot);
process.env.SIMFORGE_NATIVE_RENDER_BINARY ||= resolve(process.env.SIMFORGE_NATIVE_RUNTIME_ROOT, "bin/native-render-service");
process.env.SIMFORGE_BROWSER_HARNESS_URL ||= pathToFileURL(resolve(stageRoot, manifest.browserHarness)).href;

const config = localHostConfig();
const plan: LocalHostPlan = {
  server: { command: process.execPath, args: [resolve(stageRoot, manifest.server)], cwd: studioRoot },
  worker: { command: process.execPath, args: [resolve(stageRoot, manifest.workerEntry)], cwd: studioRoot },
};
process.exit(await runLocalHost(plan, config));
