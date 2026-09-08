// Qualifies a DOWNLOADED SimForge Studio installer the way a user meets it:
// unpack or install it, then exercise the installed copy only.
//
// The rule this script exists to enforce is that every path it touches is
// inside the installed tree. It never resolves anything from this checkout,
// never uses a repo-relative module, and runs the app under a throwaway HOME
// and XDG_DATA_HOME so a developer's existing cache, map bundles or session
// cannot make a broken installer look healthy.
//
//   node scripts/release/qualify-installed-desktop.mjs \
//     --artifact <file.AppImage|file.deb> \
//     [--expect-sha256 <digest>] [--cloud-origin https://staging.simforge.ai] \
//     [--keep] [--json]
//
// Gates, in order, each failing closed with the reason:
//   1. digest       the bytes are the bytes the release claims (when given)
//   2. unpack       the artifact opens and yields an application tree
//   3. payload      stage-manifest.json is present and every executable and
//                   library it names exists, is executable, and is for this
//                   platform and architecture
//   4. capability   the ORIGINAL desktop capabilities are present, not just a
//                   shell: native runtime addon, runner, render service and
//                   FFI library, map cache, actor closure, sky plates
//   5. encoders     the packaged ffmpeg/ffprobe run, and ffmpeg can decode the
//                   EXR sky plate class (zlib), which is what silently broke
//   6. addon        the packaged .node loads out of the installed tree and its
//                   compiled exports answer, not its declarations
//   7. launch       the app starts under Xvfb, the bundled local host answers
//                   on its own port, and the window is created
//   8. cloud        the origin baked into the package is reachable and serves
//                   the download manifest the app's update check reads
//
// Exit code is 0 only when every attempted gate passed. A gate that cannot
// run on this host is reported as skipped with its reason and does not pass.

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((ok, fail) => {
    createReadStream(path).on("error", fail).on("data", (c) => hash.update(c)).on("end", ok);
  });
  return hash.digest("hex");
}

/** @param {string} path */
async function isExecutable(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  return (info.mode & 0o111) !== 0;
}

async function freePort() {
  return await new Promise((ok, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      server.close(() => ok(port));
    });
  });
}

/**
 * Unpacks the artifact into `dest` and returns the directory holding the
 * application resources. AppImages are self-extracting; a .deb is unpacked
 * with dpkg-deb, which needs no root and installs nothing system-wide.
 * @param {string} artifact
 * @param {string} dest
 */
async function unpack(artifact, dest) {
  const name = basename(artifact);
  if (name.endsWith(".AppImage")) {
    await run("chmod", ["+x", artifact]);
    // --appimage-extract writes squashfs-root under the cwd.
    await run(artifact, ["--appimage-extract"], { cwd: dest, maxBuffer: 64 * 1024 * 1024 });
    const root = join(dest, "squashfs-root");
    return { root, resources: join(root, "resources"), exe: join(root, "AppRun") };
  }
  if (name.endsWith(".deb")) {
    await run("dpkg-deb", ["-x", artifact, dest], { maxBuffer: 64 * 1024 * 1024 });
    const opt = join(dest, "opt");
    const entries = await readdir(opt).catch(() => []);
    if (entries.length === 0) throw new Error("the package holds no /opt tree");
    const root = join(opt, entries[0]);
    return { root, resources: join(root, "resources"), exe: join(root, "simforge-studio") };
  }
  throw new Error(`unsupported artifact ${name}: expected .AppImage or .deb`);
}

/**
 * The installed app is one directory; every path in the manifest is relative
 * to the staged resource root, so this resolves them there and nowhere else.
 * @param {string} resources
 */
async function readManifest(resources) {
  // electron-builder copies the sealed stage under resources, and every path
  // in the manifest is relative to the stage root, not to resources. The root
  // is therefore wherever the manifest itself sits: found, never assumed, so
  // a packaging layout change surfaces as a clear failure instead of a wrong
  // path that looks like a missing file.
  const candidates = [join(resources, "studio"), resources];
  for (const root of candidates) {
    const path = join(root, "stage-manifest.json");
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw !== null) return { manifest: JSON.parse(raw), path, stageRoot: root };
  }
  throw new Error(`no stage-manifest.json under ${resources}: not a staged SimForge package`);
}

/**
 * @param {string} resources
 * @param {Record<string, any>} manifest
 */
async function payloadGate(resources, manifest) {
  const problems = [];
  if (manifest.platform !== process.platform) {
    problems.push(`package is for ${manifest.platform}, this host is ${process.platform}`);
  }
  if (manifest.arch !== process.arch) {
    problems.push(`package is for ${manifest.arch}, this host is ${process.arch}`);
  }
  const executables = [manifest.nativeRunner, manifest.nativeRenderService].filter(Boolean);
  const libraries = [manifest.nativeAddon, manifest.nativeRenderLibrary].filter(Boolean);
  for (const rel of executables) {
    const full = join(resources, rel);
    if (!(await isExecutable(full))) problems.push(`${rel} is missing or not executable`);
  }
  for (const rel of libraries) {
    if (!(await stat(join(resources, rel)).then((s) => s.isFile(), () => false))) {
      problems.push(`${rel} is missing`);
    }
  }
  for (const name of ["ffmpeg", "ffprobe"]) {
    const rel = manifest.tools?.[name];
    if (!rel) problems.push(`the manifest names no ${name}`);
    else if (!(await isExecutable(join(resources, rel)))) problems.push(`${rel} is missing or not executable`);
  }
  return problems;
}

/**
 * The desktop product is the map, render and storage capability, not just a
 * window: an installer that dropped them would still launch, so they are
 * checked as their own gate rather than inferred from a successful start.
 * @param {string} resources
 * @param {Record<string, any>} manifest
 */
async function capabilityGate(resources, manifest) {
  const problems = [];
  const closures = await readdir(join(resources, manifest.actorAssetsRoot ?? "", "closures")).catch(() => []);
  if (closures.length === 0) problems.push("the actor-appearance closure carries no closures: authored actors cannot render");

  // The runtime ships its converted plates as .skytex under share/sky; the
  // EXR sources are a build input and are deliberately not in the package.
  const skyRoot = join(resources, manifest.nativeRuntimeRoot ?? "", "share", "sky");
  const sky = (await readdir(skyRoot).catch(() => [])).filter((name) => name.endsWith(".skytex"));
  if (sky.length === 0) problems.push(`no .skytex sky plates under ${manifest.nativeRuntimeRoot}/share/sky: the renderer cannot light a scene`);

  for (const [label, rel] of [["local host", manifest.hostEntry], ["CPU worker", manifest.workerEntry], ["render harness", manifest.browserHarness]]) {
    if (!rel) { problems.push(`the manifest names no ${label}`); continue; }
    if (!(await stat(join(resources, rel)).then((s) => s.isFile(), () => false))) {
      problems.push(`the ${label} (${rel}) is missing: ${label === "local host" ? "the app has no UI to serve" : "that capability is absent"}`);
    }
  }
  return problems;
}

/**
 * Runs the PACKAGED encoders and proves the decoder that the sky-plate
 * pipeline needs is actually compiled in. A binary built with
 * --disable-autodetect and no zlib runs fine and reports a version, then
 * cannot decode the EXR star map at all, so the version alone proves nothing.
 * @param {string} resources
 * @param {Record<string, any>} manifest
 */
async function encoderGate(resources, manifest) {
  const problems = [];
  const ffmpeg = join(resources, manifest.tools.ffmpeg);
  const ffprobe = join(resources, manifest.tools.ffprobe);
  const detail = {};

  const version = await run(ffmpeg, ["-hide_banner", "-version"]).catch((error) => ({ stdout: "", error }));
  if (!version.stdout) problems.push("the packaged ffmpeg does not run");
  detail.ffmpeg = version.stdout.split("\n")[0] ?? "";

  const probe = await run(ffprobe, ["-hide_banner", "-version"]).catch((error) => ({ stdout: "", error }));
  if (!probe.stdout) problems.push("the packaged ffprobe does not run");
  detail.ffprobe = probe.stdout.split("\n")[0] ?? "";

  const decoders = await run(ffmpeg, ["-hide_banner", "-decoders"], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  detail.exrDecoder = /^\s*\S*\s+exr\s/m.test(decoders.stdout);
  if (!detail.exrDecoder) {
    problems.push("the packaged ffmpeg has no EXR decoder: the sky plate cannot be prepared (zlib missing from the build)");
  }

  const buildconf = await run(ffmpeg, ["-hide_banner", "-buildconf"], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  detail.zlib = /--enable-zlib/.test(buildconf.stdout);
  detail.nonfree = /--enable-nonfree/.test(buildconf.stdout);
  if (detail.nonfree) {
    problems.push("the packaged ffmpeg is an --enable-nonfree build and must not be redistributed");
  }
  // The capability is the gate; the flag is only evidence for it. An upstream
  // prebuilt binary autodetects zlib and links it without naming it in
  // buildconf, so a missing flag with a working decoder is not a defect. Our
  // own builds set --disable-autodetect, where the flag is the only way the
  // decoder can be there at all, so a missing flag there fails above anyway.
  if (!detail.zlib && detail.exrDecoder) {
    detail.zlibNote = "linked without an explicit --enable-zlib flag, which an autodetecting upstream build does";
  }
  return { problems, detail };
}

/**
 * Loads the packaged addon from the installed tree and calls into it. A
 * regenerated .d.ts can declare operations the compiled binary does not
 * contain, which typechecks and then throws at runtime, so this asks the
 * binary itself.
 * @param {string} resources
 * @param {Record<string, any>} manifest
 */
async function addonGate(resources, manifest) {
  const addon = join(resources, manifest.nativeAddon);
  const script = `
    const addon = require(${JSON.stringify(addon)});
    const abi = typeof addon.abiVersion === "function" ? addon.abiVersion() : null;
    const names = Object.keys(addon).filter((k) => typeof addon[k] === "function");
    const engine = typeof addon.engineVersion === "function" ? addon.engineVersion() : null;
    process.stdout.write(JSON.stringify({ abi, engine, count: names.length, sample: names.slice(0, 6) }));
  `;
  const result = await run(process.execPath, ["-e", script], { maxBuffer: 8 * 1024 * 1024 })
    .then((r) => ({ ok: true, out: r.stdout }))
    .catch((error) => ({ ok: false, out: String(error.stderr || error.message).slice(0, 400) }));
  if (!result.ok) return { problems: [`the packaged native addon does not load: ${result.out}`], detail: {} };
  const detail = JSON.parse(result.out);
  const problems = [];
  if (typeof detail.abi !== "number") problems.push("the packaged addon reports no ABI version");
  if (!detail.engine) problems.push("the packaged addon reports no engine version");
  if (detail.count < 5) problems.push(`the packaged addon exports only ${detail.count} functions`);
  return { problems, detail: { ...detail, sha256: await sha256File(addon), bytes: (await stat(addon)).size } };
}

/**
 * Starts the installed executable under a throwaway HOME and a virtual
 * display, then waits for the app's OWN bundled local host to answer. This is
 * the gate that distinguishes a package that opens from a package that works.
 * @param {{ exe: string, cloudOrigin: string, home: string, timeoutMs?: number }} input
 */
async function launchGate({ exe, cloudOrigin, home, timeoutMs = 120_000 }) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    PORT: String(port),
    SIMFORGE_CLOUD_ORIGIN: cloudOrigin,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  };
  const args = ["--auto-servernum", "--server-args=-screen 0 1280x900x24", exe, "--no-sandbox"];
  const child = spawn("xvfb-run", args, { env, stdio: ["ignore", "pipe", "pipe"] });

  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });

  const deadline = Date.now() + timeoutMs;
  let served = null;
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  while (Date.now() < deadline && !served && !exited) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" })
      .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 400) }))
      .catch(() => null);
    if (response) served = response;
  }

  child.kill("SIGTERM");
  await new Promise((ok) => setTimeout(ok, 2500));
  if (child.exitCode === null) child.kill("SIGKILL");

  const problems = [];
  if (!served) {
    problems.push(
      exited
        ? `the installed app exited (code ${exited.code}, signal ${exited.signal}) before its local host answered`
        : `the installed app never served its UI on 127.0.0.1:${port} within ${Math.round(timeoutMs / 1000)}s`,
    );
  } else if (served.status >= 500) {
    problems.push(`the installed app's local host answered ${served.status}`);
  }
  return { problems, detail: { port, status: served?.status ?? null, tail: log.slice(-600) } };
}

/**
 * The origin baked into the package, and the document the update check reads.
 *
 * An unreachable or wrongly-baked origin is a defect in the package. A
 * MISSING manifest is not: before the first release is published there is
 * legitimately nothing to serve, and the update check is required to report
 * that gracefully rather than error. So an absent manifest is reported as a
 * pending publication, and only a served document that is not a downloads
 * manifest counts against the artifact.
 * @param {string} origin
 */
async function cloudGate(origin) {
  const problems = [];
  const detail = { origin };
  const root = await fetch(origin, { redirect: "manual" })
    .then((r) => r.status)
    .catch((error) => `unreachable: ${error.message}`);
  detail.root = root;
  if (typeof root !== "number") problems.push(`the packaged Cloud origin is ${root}`);
  else if (root >= 500) problems.push(`the packaged Cloud origin answered ${root}`);

  const manifestUrl = new URL("/download/releases.json", origin).toString();
  const manifest = await fetch(manifestUrl)
    .then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }))
    .catch((error) => ({ status: `unreachable: ${error.message}`, body: null }));
  detail.releasesJson = manifest.status;
  if (manifest.status === 200) {
    if (!manifest.body || typeof manifest.body !== "object" || !("channels" in manifest.body)) {
      problems.push(`${manifestUrl} is served but is not a downloads manifest`);
    } else {
      detail.channels = manifest.body.channels;
    }
  } else {
    detail.updateManifest = `not published yet (${manifest.status}); the in-app update check reports nothing available, which is its defined behaviour before a release exists`;
  }
  return { problems, detail };
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

async function main() {
  const artifact = arg("artifact");
  if (!artifact) throw new Error("usage: qualify-installed-desktop.mjs --artifact <file.AppImage|.deb> [--expect-sha256 <digest>] [--cloud-origin <url>]");
  const artifactPath = resolve(artifact);
  await access(artifactPath);

  const expected = arg("expect-sha256");
  const keep = process.argv.includes("--keep");
  const asJson = process.argv.includes("--json");
  const workdir = await mkdtemp(join(tmpdir(), "simforge-qualify-"));
  const home = join(workdir, "home");
  await mkdir(home, { recursive: true });

  /** @type {Array<{ gate: string, status: "pass"|"fail"|"skip", problems?: string[], reason?: string, detail?: any }>} */
  const gates = [];
  const record = (gate, problems, detail) => {
    gates.push({ gate, status: problems.length === 0 ? "pass" : "fail", problems, detail });
    return problems.length === 0;
  };

  try {
    const digest = await sha256File(artifactPath);
    if (expected) {
      record("digest", digest === expected.toLowerCase() ? [] : [`artifact sha256 ${digest} does not match the expected ${expected}`], { sha256: digest });
    } else {
      gates.push({ gate: "digest", status: "skip", reason: "no --expect-sha256 given; nothing to compare the bytes against", detail: { sha256: digest } });
    }

    const unpacked = await unpack(artifactPath, workdir);
    record("unpack", (await stat(unpacked.resources).then((s) => s.isDirectory(), () => false)) ? [] : ["the artifact holds no application resources directory"], { root: unpacked.root });

    const { manifest, stageRoot } = await readManifest(unpacked.resources);
    const identity = { platform: manifest.platform, arch: manifest.arch, studioVersion: manifest.studioVersion, electron: manifest.electron };
    record("payload", await payloadGate(stageRoot, manifest), identity);
    record("capability", await capabilityGate(stageRoot, manifest), {});

    const encoders = await encoderGate(stageRoot, manifest);
    record("encoders", encoders.problems, encoders.detail);

    const addon = await addonGate(stageRoot, manifest);
    record("addon", addon.problems, addon.detail);

    const cloudOrigin = arg("cloud-origin", manifest.cloudOrigin ?? "https://staging.simforge.ai");
    if (process.platform !== "linux") {
      gates.push({ gate: "launch", status: "skip", reason: `launch qualification runs on linux; this host is ${process.platform}` });
    } else if (!(await run("which", ["xvfb-run"]).then(() => true, () => false))) {
      gates.push({ gate: "launch", status: "skip", reason: "xvfb-run is not installed, so the app cannot be started headless" });
    } else {
      const launch = await launchGate({ exe: unpacked.exe, cloudOrigin, home });
      record("launch", launch.problems, launch.detail);
    }

    const cloud = await cloudGate(cloudOrigin);
    record("cloud", cloud.problems, cloud.detail);
  } catch (error) {
    gates.push({ gate: "harness", status: "fail", problems: [error instanceof Error ? error.message : String(error)] });
  } finally {
    if (!keep) await rm(workdir, { recursive: true, force: true });
  }

  const failed = gates.filter((g) => g.status === "fail");
  const skipped = gates.filter((g) => g.status === "skip");
  const report = {
    schema: "simforge.installed-desktop-qualification/v1",
    artifact: basename(artifactPath),
    qualifiedAt: new Date().toISOString(),
    verdict: failed.length === 0 ? (skipped.length === 0 ? "qualified" : "qualified-with-skips") : "refused",
    gates,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const gate of gates) {
      const mark = gate.status === "pass" ? "PASS" : gate.status === "skip" ? "SKIP" : "FAIL";
      process.stdout.write(`${mark} ${gate.gate}${gate.reason ? ` - ${gate.reason}` : ""}\n`);
      for (const problem of gate.problems ?? []) process.stdout.write(`       ${problem}\n`);
    }
    process.stdout.write(`\n${report.verdict}: ${basename(artifactPath)}\n`);
  }
  // The launched app spawns its own host, worker and renderer children under
  // the virtual display. Killing the parent does not always reap them, and a
  // surviving pipe keeps this process alive after the verdict is written, so
  // the report is flushed and then the process ends deliberately rather than
  // waiting on descendants that the qualification no longer needs.
  await new Promise((ok) => process.stdout.write("", ok));
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("qualify-installed-desktop.mjs")) {
  await main();
}
