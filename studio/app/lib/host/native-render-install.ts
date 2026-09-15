import "server-only";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ABI_VERSION, nativeExecutableName, nativeRuntimeRoot } from "@simforge-oss/native-runtime";
import { probeLocalNativeRender } from "@simforge-oss/render/native";
import type { NativeRenderInstall, NativeRenderInstallStep } from "@simforge-oss/studio-host";
import { probeNativeRuntime } from "@simforge-oss/studio-host/node";

/**
 * Installs the native runtime a render needs into the runtime root every
 * probe already reads (`@simforge-oss/render/native` for the service, encoder
 * and actor closure; `@simforge-oss/studio-host/node` for the runner), so no
 * other code learns a new location.
 *
 * A packaged desktop build stages all of it, so this only ever runs on a
 * workspace host. The runtime itself is a published, pinned artifact:
 * `scripts/native-runtime/fetch-runtime.mjs` downloads the archive named by
 * `scripts/native-runtime/runtime-release.json`, refuses bytes whose sha256
 * or size differ, refuses a pin whose binding ABI is not {@link ABI_VERSION},
 * and `install-runtime.mjs` installs it as an immutable generation — the same
 * shape as the pinned actor closure and sky plates. Building from source is
 * the developer path: it needs a Rust toolchain, so it is taken only when a
 * developer asks for it (`SIMFORGE_NATIVE_RUNTIME_FROM_SOURCE`) or no
 * artifact is published for this platform. Which path ran is always said.
 *
 * The NASA sky plates are prepared (`renderer/tools/prepare_sky_assets.py`)
 * only on the source path; a published archive carries them. Encoders are not
 * installed: the probe accepts `ffmpeg`/`ffprobe` on `PATH` and the
 * generation's `bin/` is managed by the installer, not by us.
 *
 * One install runs at a time per host; its progress is the status every
 * caller reads. The result is never inferred: the final step re-runs the probes.
 */

const STEP_NAMES = ["sky-assets", "runtime", "encoder", "actor-assets"] as const;
type StepName = (typeof STEP_NAMES)[number];

/**
 * Fetch failures that mean "there is nothing published for this platform", as
 * opposed to "what is published did not verify". Only the former may fall
 * back to a source build: silently building past a digest or ABI refusal
 * would install exactly the mismatched runtime the pin exists to prevent.
 */
const NO_ARTIFACT: Record<string, true> = {
  "runtime.no_prebuilt": true,
  "runtime.no_prebuilt_for_target": true,
  "runtime.unsupported_target": true,
};

let current: NativeRenderInstall | null = null;
let running: Promise<NativeRenderInstall> | null = null;

function repoRoot(): string {
  // studio/ is the host's cwd both in the workspace and the staged package.
  return resolve(process.cwd(), "..");
}

function runtimeScripts(): string {
  return join(repoRoot(), "scripts", "native-runtime");
}

function freshSteps(): NativeRenderInstallStep[] {
  return STEP_NAMES.map((name) => ({ name, state: "pending", detail: null }));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function firstOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** A failed runtime script, carrying the `code` it reported on stderr. */
class ScriptFailure extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** The `{code, reason}` document every scripts/native-runtime failure ends with. */
function failureCode(stderr: string): string | null {
  for (const line of stderr.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") return parsed.code;
    } catch {
      continue;
    }
  }
  return null;
}

function run(command: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<string> {
  const { promise, resolve: finish, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  let tail = "";
  const consume = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    tail = (tail + text).split("\n").slice(-4).join("\n");
    for (const line of text.split("\n")) if (line.trim()) onLine(line.trim());
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    consume(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    consume(chunk);
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) finish(stdout);
    else reject(new ScriptFailure(`${command} ${args.join(" ")} exited with ${code}: ${tail}`, failureCode(stderr)));
  });
  return promise;
}

function lastJson<T>(output: string): T {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as T;
}

async function download(url: string, target: string, log: (detail: string) => void): Promise<void> {
  log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  await mkdir(join(target, ".."), { recursive: true });
  const staging = `${target}.downloading`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(staging));
  await rename(staging, target);
}

type SkySource = { product?: string; product_sha256?: string; file_url: string; download?: string; download_sha256?: string };

function skyDir(): string {
  return join(repoRoot(), "renderer", "render-core", "assets", "sky");
}

async function readSkySources(): Promise<SkySource[]> {
  return (JSON.parse(await readFile(join(skyDir(), "SOURCES.json"), "utf8")) as { sources: SkySource[] }).sources;
}

/**
 * The plates the build packages must carry the digests `SOURCES.json` pins:
 * the runtime manifest refuses anything else. Presence alone is not enough,
 * since the conversion tool rewrites the pins beside the plates it emits.
 */
async function skyPlatesMatchSources(): Promise<boolean> {
  const sources = await readSkySources().catch(() => null);
  if (!sources) return false;
  for (const source of sources) {
    if (!source.product || !source.product_sha256) continue;
    const plate = join(skyDir(), source.product);
    if (!(await exists(plate)) || (await sha256(plate)) !== source.product_sha256) return false;
  }
  return true;
}

/**
 * The renderer refuses to build a scene without the two NASA plates; the
 * tool that converts them reads the originals from `renderer/assets-src`
 * and rewrites `SOURCES.json` with the digests of what it emitted.
 * Originals already present with the recorded digest are not fetched again.
 */
async function installSkyAssets(log: (detail: string) => void): Promise<string> {
  const renderer = join(repoRoot(), "renderer");
  const sources = await readSkySources();
  const inputs = join(renderer, "assets-src");
  for (const source of sources) {
    const name = source.download ?? source.file_url.slice(source.file_url.lastIndexOf("/") + 1);
    const target = join(inputs, name);
    if ((await exists(target)) && (!source.download_sha256 || (await sha256(target)) === source.download_sha256)) continue;
    await download(source.file_url, target, log);
  }
  const tool = join(renderer, "tools", "prepare_sky_assets.py");
  log("Converting the sky plates");
  const uv = await firstOnPath(nativeExecutableName("uv"));
  if (uv) await run(uv, ["run", "--with", "numpy", "--with", "pillow", "python", tool], renderer, log);
  else await run(process.platform === "win32" ? "python" : "python3", [tool], renderer, log);
  return skyDir();
}

type FetchedRuntime = {
  archive: string;
  target: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  revision: string;
  abi: number;
  cached: boolean;
};

/** Installs one archive as an immutable generation; returns what it reports being. */
async function installArchive(archive: string, root: string, log: (detail: string) => void): Promise<{ version: string | null; revision: string | null }> {
  log(`Installing ${archive}`);
  const installed = await run(process.execPath, [join(runtimeScripts(), "install-runtime.mjs"), archive, "--root", root], repoRoot(), log);
  const report = lastJson<{ runtime?: { version?: string; revision?: string } }>(installed);
  return { version: report.runtime?.version ?? null, revision: report.runtime?.revision ?? null };
}

/** Builds the runtime here. The developer path: it needs a Rust toolchain. */
async function buildRuntimeFromSource(root: string, log: (detail: string) => void): Promise<void> {
  const scripts = runtimeScripts();
  if (!(await exists(join(scripts, "package-runtime.mjs")))) {
    throw new Error("This installation has no runtime source to build from.");
  }
  const cargo = (await firstOnPath(nativeExecutableName("cargo"))) ?? join(process.env.HOME ?? "", ".cargo", "bin", nativeExecutableName("cargo"));
  if (!(await exists(cargo))) throw new Error("Building the native runtime needs a Rust toolchain (cargo was not found).");
  log("Building the native runtime from source; the first build takes several minutes.");
  const packaged = await run(process.execPath, [join(scripts, "package-runtime.mjs"), "--no-gpu-interop"], repoRoot(), (line) => {
    if (/^(Compiling|Finished|Building)/u.test(line)) log(line.slice(0, 120));
  });
  const report = lastJson<{ archive?: string }>(packaged);
  if (!report.archive) throw new Error("package-runtime.mjs produced no archive");
  await installArchive(report.archive, root, log);
  log("Installed the runtime built from source.");
}

/**
 * Installs the runtime generation the runner probe discovers: the pinned
 * prebuilt artifact by default, a source build only when asked for or when
 * no artifact is published for this platform. A digest or ABI refusal ends
 * the install; it never becomes a source build behind the user's back.
 */
async function installRuntime(root: string, log: (detail: string) => void): Promise<string> {
  const explicit = process.env.SIMFORGE_NATIVE_RUNTIME_ARCHIVE?.trim();
  if (explicit) {
    log(`Installing the archive named by SIMFORGE_NATIVE_RUNTIME_ARCHIVE: ${explicit}`);
    await installArchive(explicit, root, log);
    return join(root, "bin");
  }

  const fromSource = /^(1|true|yes)$/iu.test(process.env.SIMFORGE_NATIVE_RUNTIME_FROM_SOURCE?.trim() ?? "");
  if (fromSource) {
    log("SIMFORGE_NATIVE_RUNTIME_FROM_SOURCE is set: building the runtime from source instead of installing the published artifact.");
    await buildRuntimeFromSource(root, log);
    return join(root, "bin");
  }

  let fetched: FetchedRuntime | null = null;
  try {
    log("Looking for the pinned prebuilt runtime for this platform");
    const output = await run(
      process.execPath,
      [join(runtimeScripts(), "fetch-runtime.mjs"), "--root", root, "--abi", String(ABI_VERSION)],
      repoRoot(),
      (line) => log(line.slice(0, 160)),
    );
    fetched = lastJson<FetchedRuntime>(output);
  } catch (error) {
    const code = error instanceof ScriptFailure ? error.code : null;
    if (code === null || NO_ARTIFACT[code] !== true) throw error;
    log(`No prebuilt runtime is published for this platform (${code}); building it from source instead, which needs a Rust toolchain.`);
  }

  if (!fetched) {
    await buildRuntimeFromSource(root, log);
    return join(root, "bin");
  }

  log(
    `Verified the prebuilt runtime ${fetched.version} (${fetched.revision.slice(0, 12)}) for ${fetched.target}: sha256 ${fetched.sha256.slice(0, 12)}…, ${fetched.sizeBytes} bytes, binding ABI ${fetched.abi} matches the ABI ${ABI_VERSION} this build requires${fetched.cached ? " (already in the download cache)" : ""}.`,
  );
  const installed = await installArchive(fetched.archive, root, log);
  if (installed.version !== fetched.version || installed.revision !== fetched.revision) {
    throw new Error(
      `the installed runtime reports ${installed.version}/${installed.revision} but the pinned artifact is ${fetched.version}/${fetched.revision}; the archive does not hold the runtime it was published as`,
    );
  }
  log(`Installed the prebuilt runtime ${fetched.version} (${fetched.revision.slice(0, 12)}); no source build was needed.`);
  return join(root, "bin");
}

async function installEncoders(log: (detail: string) => void): Promise<string> {
  const found: string[] = [];
  for (const stem of ["ffmpeg", "ffprobe"]) {
    const path = process.env[`SIMFORGE_${stem.toUpperCase()}_BINARY`]?.trim() || (await firstOnPath(nativeExecutableName(stem)));
    if (!path) {
      throw new Error(`${stem} is not installed on this machine. Install it (for example \`brew install ffmpeg\`) and try again.`);
    }
    log(`Using ${path}`);
    found.push(path);
  }
  return found[0]!;
}

async function installActorAssets(root: string, log: (detail: string) => void): Promise<string> {
  const script = join(repoRoot(), "packages", "render", "scripts", "fetch-actor-closure.mjs");
  if (!(await exists(script))) throw new Error("The actor closure fetch script is not part of this installation.");
  const out = join(root, "share", "actor-assets");
  log("Fetching the pinned actor-appearance closure");
  await run(process.execPath, [script, "--out", out], repoRoot(), (line) => log(line.slice(0, 120)));
  return out;
}

/** What the probes say is still missing, as the step that would supply it. */
async function satisfied(): Promise<Record<StepName, boolean>> {
  const render = probeLocalNativeRender();
  const runner = await probeNativeRuntime();
  return {
    // A published archive carries the plates; only a source build needs them
    // converted here, and then only when the runtime step will build.
    "sky-assets": render.renderService.state === "available" || (await skyPlatesMatchSources()),
    runtime: render.renderService.state === "available" && runner.state === "available",
    encoder: render.encoder.state === "available",
    "actor-assets": render.actorAssets.state === "available",
  };
}

async function snapshot(): Promise<NativeRenderInstall> {
  const render = probeLocalNativeRender();
  const runner = await probeNativeRuntime();
  const reasons = [...render.reasons];
  if (runner.state === "unavailable") reasons.push(runner.reason);
  const installed = reasons.length === 0;
  return {
    state: current?.state ?? (installed ? "installed" : "not-installed"),
    runtimeRoot: render.runtimeRoot,
    installed,
    reasons,
    steps: current?.steps ?? freshSteps(),
    error: current?.error ?? null,
  };
}

/** What is installed and, while an install runs, how far it is. */
export function readNativeRenderInstall(): Promise<NativeRenderInstall> {
  return snapshot();
}

/**
 * Starts (or joins) the install. Returns immediately with the current
 * status; callers poll {@link readNativeRenderInstall}. Steps the probes
 * already find satisfied are skipped, so a partial install resumes.
 */
export async function startNativeRenderInstall(): Promise<NativeRenderInstall> {
  if (running) return snapshot();
  const root = nativeRuntimeRoot();
  current = { ...(await snapshot()), state: "installing", steps: freshSteps(), error: null };
  const update = (name: StepName, patch: Partial<NativeRenderInstallStep>) => {
    if (!current) return;
    current = { ...current, steps: current.steps.map((step) => (step.name === name ? { ...step, ...patch } : step)) };
  };
  const log = (name: StepName) => (detail: string) => update(name, { detail });
  running = (async () => {
    try {
      for (const name of STEP_NAMES) {
        if ((await satisfied())[name]) {
          update(name, { state: "done", detail: "Already installed" });
          continue;
        }
        update(name, { state: "running", detail: null });
        const path = name === "sky-assets"
          ? await installSkyAssets(log(name))
          : name === "runtime"
            ? await installRuntime(root, log(name))
            : name === "encoder"
              ? await installEncoders(log(name))
              : await installActorAssets(root, log(name));
        update(name, { state: "done", detail: path });
      }
      const verdict = await snapshot();
      current = {
        ...current!,
        state: verdict.installed ? "installed" : "failed",
        error: verdict.installed ? null : verdict.reasons.join(" "),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = {
        ...current!,
        state: "failed",
        error: message,
        steps: current!.steps.map((step) => (step.state === "running" ? { ...step, state: "failed", detail: message } : step)),
      };
    } finally {
      running = null;
    }
    return snapshot();
  })();
  return snapshot();
}
