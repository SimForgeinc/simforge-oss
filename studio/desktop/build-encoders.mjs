#!/usr/bin/env node
// Builds the ffmpeg/ffprobe the desktop package bundles, from the sources
// pinned in desktop/encoders.lock.json, and writes the corresponding source
// that redistributing them obliges us to provide.
//
//   node desktop/build-encoders.mjs [--target <platform-arch>] [--jobs <n>]
//
// Output (the layout desktop/stage.mjs already consumes):
//   dist/desktop-tools/<platform>-<arch>/ffmpeg[.exe]
//   dist/desktop-tools/<platform>-<arch>/ffprobe[.exe]
//   dist/desktop-tools/<platform>-<arch>/LICENSE
//   dist/desktop-tools/<platform>-<arch>/tools-manifest.json
//   dist/desktop-tools/<platform>-<arch>/corresponding-source/
//       simforge-studio-encoders-<target>-corresponding-source.tar.gz
//
// Why this exists instead of downloading a static build: the four packages
// used to carry three different third-party builds with three different
// licenses, one of them configured --enable-nonfree, which may not be
// redistributed at all. Nobody publishes the corresponding source for those
// builds either. Building from pinned source produces one license outcome
// everywhere, a closure we chose (--disable-autodetect, so nothing enters
// the binary because it happened to be installed on the runner), and a
// source archive we can attach to the release, which discharges GPL-3.0
// section 6 by accompaniment rather than by a written offer nobody honours.
//
// Sources are pinned by Git commit. A commit id is a hash of the whole tree,
// so unlike a generated archive's digest it cannot drift, and the build
// refuses to continue if the checkout is not exactly that commit.
//
// This script is itself part of the corresponding source it writes: the
// archive holds both projects at their pinned commits, this file, the lock,
// and a BUILD.md recording the exact configure lines and toolchain versions,
// which is what "the scripts used to control compilation and installation"
// means.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { targetFor } from "./stage-manifest.mjs";

const run = promisify(execFile);
const desktopDir = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = "encoders.lock.json";
const lock = JSON.parse(await readFile(join(desktopDir, LOCK_FILE), "utf8"));
if (lock.schema !== "simforge.desktop-encoders-lock/v1") {
  throw new Error(`desktop/${LOCK_FILE}: unsupported schema ${lock.schema}`);
}

export const TOOLS_MANIFEST_SCHEMA = "simforge.desktop-tools/v2";
export const TOOLS_MANIFEST_FILE = "tools-manifest.json";
export const CORRESPONDING_SOURCE_DIR = "corresponding-source";
/** The two tools the host spawns. Nothing else is installed from the build. */
export const TOOLS = Object.freeze(["ffmpeg", "ffprobe"]);

/** @param {string} path */
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * @param {string} path
 * @param {{ sha256: string; sizeBytes: number }} pin
 */
export async function matchesPin(path, pin) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== pin.sizeBytes) return false;
  return (await sha256File(path)) === pin.sha256;
}

/**
 * Where one target's encoders and their provenance live.
 * @param {string} distRoot studio/dist
 * @param {ReturnType<typeof targetFor>} target
 */
export function toolsLayout(distRoot, target) {
  const dir = join(distRoot, "desktop-tools", target.key);
  return {
    dir,
    ffmpeg: join(dir, `ffmpeg${target.exe}`),
    ffprobe: join(dir, `ffprobe${target.exe}`),
    license: join(dir, "LICENSE"),
    manifest: join(dir, TOOLS_MANIFEST_FILE),
    correspondingSourceDir: join(dir, CORRESPONDING_SOURCE_DIR),
    correspondingSource: join(dir, CORRESPONDING_SOURCE_DIR, `simforge-studio-encoders-${target.key}-corresponding-source.tar.gz`),
    version: sourceFor("ffmpeg").tag.replace(/^n/, ""),
    licenseId: lock.license.id,
  };
}

/** @param {string} id */
export function sourceFor(id) {
  const source = lock.sources.find((/** @type {any} */ entry) => entry.id === id);
  if (!source) throw new Error(`desktop/${LOCK_FILE} pins no source called ${id}`);
  return source;
}

/**
 * The digests of the encoders actually built for a target, read from the
 * manifest the build wrote, with the manifest proven to describe the sources
 * this repository pins. This is the root of the packaging integrity chain:
 * desktop/stage.mjs, desktop/after-pack.mjs and desktop/verify-package.mjs
 * all compare the bytes they see against these, and a manifest built from
 * different sources than the lock names is refused here rather than trusted
 * downstream.
 *
 * @param {string} distRoot
 * @param {ReturnType<typeof targetFor>} target
 * @returns {Promise<Record<string, { sha256: string; sizeBytes: number }> & { manifest: any }>}
 */
export async function readToolPins(distRoot, target) {
  const layout = toolsLayout(distRoot, target);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(layout.manifest, "utf8"));
  } catch (error) {
    throw new Error(
      `${layout.manifest} is missing or unreadable: run "node desktop/build-encoders.mjs --target ${target.key}" first (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (manifest.schema !== TOOLS_MANIFEST_SCHEMA) {
    throw new Error(`${layout.manifest}: unsupported schema ${manifest.schema}`);
  }
  if (manifest.target !== target.key) {
    throw new Error(`${layout.manifest} was built for ${manifest.target}, not ${target.key}`);
  }
  for (const pinned of lock.sources) {
    const built = (manifest.sources ?? []).find((/** @type {any} */ entry) => entry.id === pinned.id);
    if (!built) throw new Error(`${layout.manifest} does not record the ${pinned.id} source`);
    if (built.commit !== pinned.commit) {
      throw new Error(
        `${layout.manifest} was built from ${pinned.id} ${built.commit}, but desktop/${LOCK_FILE} pins ${pinned.commit}: rebuild the encoders`,
      );
    }
  }
  /** @type {any} */
  const pins = { manifest };
  for (const tool of TOOLS) {
    const entry = manifest.tools?.[tool];
    if (typeof entry?.sha256 !== "string" || !Number.isInteger(entry?.sizeBytes)) {
      throw new Error(`${layout.manifest} has no usable digest for ${tool}`);
    }
    pins[tool] = { sha256: entry.sha256, sizeBytes: entry.sizeBytes };
  }
  return pins;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string> }} [options]
 */
async function exec(command, args, options = {}) {
  process.stderr.write(`desktop encoders: ${command} ${args.join(" ")}\n`);
  const { stdout } = await run(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}


/**
 * FFmpeg's and x264's configure are POSIX shell scripts, so on Windows every
 * build command runs inside the MSYS2 MINGW64 environment (which produces
 * native Windows executables with no MSYS runtime dependency) rather than
 * being spawned directly. Elsewhere the commands are spawned as they are.
 * @param {string} cwd
 * @param {string} command already-quoted shell command line
 */
async function shellExec(cwd, command) {
  if (process.platform !== "win32") {
    return exec("bash", ["-c", command], { cwd });
  }
  const bash = process.env.SIMFORGE_MSYS2_BASH ?? "C:\\msys64\\usr\\bin\\bash.exe";
  const posixCwd = cwd.replace(/^([A-Za-z]):/, (_all, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
  return exec(bash, ["-lc", `cd '${posixCwd}' && ${command}`], { env: { MSYSTEM: "MINGW64", CHERE_INVOKING: "1" } });
}

/** A build path as the build shell sees it. */
function shellPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):/, (_all, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

/**
 * A source tree at exactly the pinned commit. A shallow fetch of the commit
 * is tried first and a full clone is the fallback, because not every mirror
 * serves arbitrary commits to `git fetch`.
 * @param {any} source
 * @param {string} dir
 */
async function checkout(source, dir) {
  const head = await exec("git", ["-C", dir, "rev-parse", "HEAD"]).catch(() => null);
  if (head !== source.commit) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await exec("git", ["-C", dir, "init", "--quiet"]);
    await exec("git", ["-C", dir, "remote", "add", "origin", source.repository]);
    try {
      await exec("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", source.commit]);
    } catch {
      await exec("git", ["-C", dir, "fetch", "--quiet", "origin"]);
    }
    await exec("git", ["-C", dir, "checkout", "--quiet", source.commit]);
  }
  const checkedOut = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (checkedOut !== source.commit) {
    throw new Error(`${dir} is at ${checkedOut}, not the pinned ${source.id} commit ${source.commit}`);
  }
  // A dirty tree would mean the binaries do not correspond to the source we
  // are about to ship as their corresponding source.
  const dirty = await exec("git", ["-C", dir, "status", "--porcelain"]);
  if (dirty !== "") throw new Error(`${dir} has local modifications; the corresponding source would be wrong`);
  return dir;
}

/** First line of a version banner, for the build record. */
async function version(command, args) {
  const output = await exec(command, args).catch(() => "");
  return output.split("\n")[0] ?? "";
}

/**
 * Build both encoders for one target and install them with their provenance.
 * @param {string} distRoot studio/dist
 * @param {ReturnType<typeof targetFor>} target
 * @param {{ jobs?: number }} [options]
 */
export async function buildEncoders(distRoot, target, { jobs = 4 } = {}) {
  const layout = toolsLayout(distRoot, target);
  const work = join(distRoot, "encoder-build", target.key);
  const prefix = join(work, "prefix");
  const ffmpegSource = sourceFor("ffmpeg");
  const x264Source = sourceFor("x264");
  const windows = target.exe === ".exe";

  await mkdir(prefix, { recursive: true });
  const ffmpegDir = await checkout(ffmpegSource, join(work, "src", "ffmpeg"));
  const x264Dir = await checkout(x264Source, join(work, "src", "x264"));

  // 1. libx264 first: FFmpeg links it statically, so it must be installed
  //    into the prefix before FFmpeg's configure looks for it.
  const x264Configure = [`--prefix=${shellPath(prefix)}`, ...lock.build.x264.configure];
  await shellExec(x264Dir, `./configure ${x264Configure.join(" ")}`);
  await shellExec(x264Dir, `make -j${jobs}`);
  await shellExec(x264Dir, "make install");

  // 2. FFmpeg against exactly that prefix. --disable-autodetect in the lock
  //    keeps external libraries out of the closure; pkg-config is pointed at
  //    our own prefix so a host-installed x264 cannot be picked up instead.
  const ffmpegConfigure = [
    `--prefix=${shellPath(prefix)}`,
    "--pkg-config-flags=--static",
    `--extra-cflags=-I${shellPath(join(prefix, "include"))}`,
    `--extra-ldflags=-L${shellPath(join(prefix, "lib"))}`,
    ...lock.build.ffmpeg.configure,
  ];
  const pkgConfigPath = shellPath(join(prefix, "lib", "pkgconfig"));
  await shellExec(ffmpegDir, `PKG_CONFIG_PATH='${pkgConfigPath}' PKG_CONFIG_LIBDIR='${pkgConfigPath}' ./configure ${ffmpegConfigure.join(" ")}`);
  await shellExec(ffmpegDir, `make -j${jobs}`);

  // 3. Install exactly the two programs, from the build tree.
  await mkdir(layout.dir, { recursive: true });
  for (const tool of TOOLS) {
    const built = join(ffmpegDir, `${tool}${target.exe}`);
    if (!(await stat(built).catch(() => null))?.isFile()) {
      throw new Error(`${built} was not produced; check the FFmpeg configure output`);
    }
    await copyFile(built, join(layout.dir, `${tool}${target.exe}`));
  }

  // 4. The applicable license texts, from the sources themselves.
  const gplv3 = await readFile(join(ffmpegDir, "COPYING.GPLv3"), "utf8");
  const x264Copying = await readFile(join(x264Dir, "COPYING"), "utf8");
  await writeFile(layout.license, [
    "SimForge Studio bundles ffmpeg and ffprobe, built from source for this",
    "distribution. Because the build links libx264 (GPL-2.0-or-later) and is",
    `configured with --enable-version3, these two executables are ${lock.license.id}.`,
    "",
    `FFmpeg ${ffmpegSource.tag} (${ffmpegSource.commit})`,
    `libx264 ${x264Source.commit}`,
    "",
    "The complete corresponding source of these executables, including the",
    "script and configure lines that produced them, is published with the",
    `release that carries them as ${CORRESPONDING_SOURCE_DIR}/`,
    "simforge-studio-encoders-<target>-corresponding-source.tar.gz.",
    "",
    "SimForge Studio itself is Apache-2.0 and is a separate program; it",
    "invokes these executables as subprocesses.",
    "",
    "================ GNU General Public License version 3 ================",
    "",
    gplv3,
    "",
    "========= GNU General Public License version 2 (libx264) =========",
    "",
    x264Copying,
    "",
  ].join("\n"));

  // 5. The corresponding source: both trees at their pinned commits, this
  //    script, the lock, and the build record. `git archive` writes the tree
  //    the commit names, so the archive cannot disagree with what was built.
  await rm(layout.correspondingSourceDir, { recursive: true, force: true });
  await mkdir(layout.correspondingSourceDir, { recursive: true });
  const staging = join(work, "corresponding-source");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  /** @type {{ id: string; commit: string; archive: string; sha256: string; sizeBytes: number }[]} */
  const archived = [];
  for (const [source, dir] of [[ffmpegSource, ffmpegDir], [x264Source, x264Dir]]) {
    const name = `${source.id}-${source.commit}.tar.gz`;
    const archive = join(staging, name);
    await exec("git", ["-C", dir, "archive", "--format=tar.gz", `--prefix=${source.id}-${source.commit}/`, "-o", archive, source.commit]);
    const [digest, info] = await Promise.all([sha256File(archive), stat(archive)]);
    archived.push({ id: source.id, commit: source.commit, archive: name, sha256: digest, sizeBytes: info.size });
  }
  await copyFile(join(desktopDir, "build-encoders.mjs"), join(staging, "build-encoders.mjs"));
  await copyFile(join(desktopDir, LOCK_FILE), join(staging, LOCK_FILE));

  const toolchain = {
    platform: `${process.platform}-${process.arch}`,
    shell: lock.build.toolchain[target.key]?.shell ?? "bash",
    compiler: await version(windows ? "gcc" : process.platform === "darwin" ? "clang" : "gcc", ["--version"]),
    make: await version("make", ["--version"]),
    nasm: await version("nasm", ["-v"]),
    git: await version("git", ["--version"]),
  };
  await writeFile(join(staging, "BUILD.md"), [
    `# Corresponding source — SimForge Studio encoders (${target.key})`,
    "",
    "This archive is the complete corresponding source of the ffmpeg and",
    "ffprobe executables bundled in the SimForge Studio package for",
    `${target.key}, as required by GPL-3.0 section 6.`,
    "",
    "## Contents",
    "",
    ...archived.map((entry) => `- \`${entry.archive}\` — ${entry.id} at commit ${entry.commit} (sha256 \`${entry.sha256}\`)`),
    "- `build-encoders.mjs` — the script that performed the build",
    `- \`${LOCK_FILE}\` — the pinned sources and configure lines`,
    "",
    "## How the binaries were produced",
    "",
    "```sh",
    `# libx264 (${x264Source.commit})`,
    `./configure ${x264Configure.join(" ")}`,
    `make -j${jobs} && make install`,
    "",
    `# FFmpeg (${ffmpegSource.commit})`,
    `PKG_CONFIG_PATH=<prefix>/lib/pkgconfig ./configure ${ffmpegConfigure.join(" ")}`,
    `make -j${jobs}`,
    "```",
    "",
    "`<prefix>` is a build-local directory; no host library participates in the",
    "link, because FFmpeg is configured with `--disable-autodetect`.",
    "",
    "## Toolchain that produced the shipped binaries",
    "",
    ...Object.entries(toolchain).map(([name, value]) => `- ${name}: ${value}`),
    "",
    "Reproducing the build needs only the toolchain above; no SimForge source",
    "is involved, and SimForge Studio does not link these programs.",
    "",
  ].join("\n"));

  await exec("tar", ["-czf", layout.correspondingSource, "-C", staging, "."]);
  const [sourceDigest, sourceInfo] = await Promise.all([sha256File(layout.correspondingSource), stat(layout.correspondingSource)]);

  // 6. The manifest every later verification step reads.
  /** @type {any} */
  const tools = {};
  for (const tool of TOOLS) {
    const path = join(layout.dir, `${tool}${target.exe}`);
    const [digest, info] = await Promise.all([sha256File(path), stat(path)]);
    tools[tool] = { file: `${tool}${target.exe}`, sha256: digest, sizeBytes: info.size };
  }
  const manifest = {
    schema: TOOLS_MANIFEST_SCHEMA,
    target: target.key,
    builtAt: new Date().toISOString(),
    version: layout.version,
    license: lock.license.id,
    licenseFile: "LICENSE",
    origin: "built-from-source",
    sources: archived.map((entry) => ({
      id: entry.id,
      repository: sourceFor(entry.id).repository,
      commit: entry.commit,
      archive: `${CORRESPONDING_SOURCE_DIR}/${entry.archive}`,
      archiveSha256: entry.sha256,
    })),
    configure: { x264: x264Configure, ffmpeg: ffmpegConfigure },
    toolchain,
    tools,
    correspondingSource: {
      file: `${CORRESPONDING_SOURCE_DIR}/${
        layout.correspondingSource.slice(layout.correspondingSourceDir.length + 1)
      }`,
      sha256: sourceDigest,
      sizeBytes: sourceInfo.size,
    },
  };
  await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { layout, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  const jobsArgument = process.argv.find((arg) => arg.startsWith("--jobs="))?.slice("--jobs=".length);
  const [platform, arch] = requested ? requested.split("-") : [process.platform, process.arch];
  const target = targetFor(/** @type {NodeJS.Platform} */ (platform), arch);
  const { layout, manifest } = await buildEncoders(resolve(desktopDir, "..", "dist"), target, {
    jobs: jobsArgument ? Number(jobsArgument) : undefined,
  });
  process.stdout.write(`${JSON.stringify({
    component: "simforge-desktop-encoders",
    event: "encoders.built",
    target: target.key,
    dir: layout.dir,
    version: manifest.version,
    license: manifest.license,
    tools: manifest.tools,
    correspondingSource: manifest.correspondingSource,
  }, null, 2)}\n`);
}
