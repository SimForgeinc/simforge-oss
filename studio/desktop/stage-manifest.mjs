// The record `desktop/stage.mjs` writes at the root of the staged resources
// and the only description of the artifact the desktop shell and the packaged
// host trust: which target the native payload was staged for and where every
// entry point and bundled dependency lives relative to the stage root. Plain
// JS so the unbundled shell (`electron desktop/main.mjs`), the bundled host
// and the package verifier share it.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const STAGE_MANIFEST_SCHEMA = "simforge.desktop-stage/v3";
export const STAGE_MANIFEST_FILE = "stage-manifest.json";

/** One application identity across every platform, profile and cache. */
export const PRODUCT = Object.freeze({
  name: "SimForge Studio",
  appId: "ai.simforge.studio",
  packageName: "simforge-studio",
  executableName: "simforge-studio",
  /** Per-user data directory name (OS conventions decide the parent). */
  dataDir: "SimForge Studio",
  landing: "/dashboard/scenario",
});

/**
 * Electron platform/arch to the Rust target triple the native runtime archive
 * and renderer are built for, and to the npm packages that carry each
 * disk-loaded dependency's native binding for that target. Only these targets
 * can be staged; there is no qualification by inference. `bindings` names,
 * per dependency the standalone host loads from disk, the packages pnpm
 * installs for this platform only: a stage holding the package of another
 * target is a Linux install masquerading as this platform's payload.
 */
export const TARGETS = Object.freeze({
  "linux-x64": Object.freeze({
    triple: "x86_64-unknown-linux-gnu",
    exe: "",
    renderLibrary: "lib/libsimforge_render.so",
    bindings: Object.freeze({ "@napi-rs/keyring": ["@napi-rs/keyring-linux-x64-gnu"], sharp: ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"] }),
  }),
  "win32-x64": Object.freeze({
    triple: "x86_64-pc-windows-msvc",
    exe: ".exe",
    renderLibrary: "lib/simforge_render.dll",
    // sharp's Windows package carries libvips itself; there is no separate libvips package.
    bindings: Object.freeze({ "@napi-rs/keyring": ["@napi-rs/keyring-win32-x64-msvc"], sharp: ["@img/sharp-win32-x64"] }),
  }),
  "darwin-arm64": Object.freeze({
    triple: "aarch64-apple-darwin",
    exe: "",
    renderLibrary: "lib/libsimforge_render.dylib",
    bindings: Object.freeze({ "@napi-rs/keyring": ["@napi-rs/keyring-darwin-arm64"], sharp: ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"] }),
  }),
  "darwin-x64": Object.freeze({
    triple: "x86_64-apple-darwin",
    exe: "",
    renderLibrary: "lib/libsimforge_render.dylib",
    bindings: Object.freeze({ "@napi-rs/keyring": ["@napi-rs/keyring-darwin-x64"], sharp: ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"] }),
  }),
});

/**
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @returns {{ key: keyof typeof TARGETS; triple: string; exe: string; renderLibrary: string; bindings: Readonly<Record<string, readonly string[]>> }}
 */
export function targetFor(platform = process.platform, arch = process.arch) {
  const key = /** @type {keyof typeof TARGETS} */ (`${platform}-${arch}`);
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`${key} is not a SimForge Studio desktop target (supported: ${Object.keys(TARGETS).join(", ")})`);
  }
  return { key, ...target };
}

/**
 * @typedef {object} StageManifest
 * @property {typeof STAGE_MANIFEST_SCHEMA} schema
 * @property {NodeJS.Platform} platform Platform the native payload targets.
 * @property {string} arch Architecture the native payload targets.
 * @property {string} target Rust target triple of the native payload.
 * @property {string} electron Electron release the stage was produced against.
 * @property {string} studioVersion `@simforge-oss/studio` version (also the app version).
 * @property {string | null} gitRevision Source revision, when staged from a checkout.
 * @property {string} nativeAddon Stage-relative path of the N-API runtime addon.
 * @property {string} nativeRuntimeRoot Stage-relative root of the verified native runtime distribution.
 * @property {{ version: string; revision: string; archiveSha256: string; supportTiers: string[] }} nativeRuntime
 * @property {string} nativeRunner Stage-relative path of `simforge-runner[.exe]`.
 * @property {string} nativeRenderService Stage-relative path of `native-render-service[.exe]`.
 * @property {string} nativeRenderLibrary Stage-relative path of the renderer FFI library.
 * @property {{ ffmpeg: string; ffprobe: string; version: string; license: string; digests?: { ffmpeg: string; ffprobe: string }; sources?: { id: string; commit: string }[]; correspondingSource?: { file: string; sha256: string; sizeBytes: number } }} tools Bundled encoder binaries, the digests of the staged bytes, and the sources they were built from.
 * @property {Record<string, Record<string, string>>} nativeBindings Per disk-loaded dependency, the stage-relative directory of each per-target binding package it resolves.
 * @property {string} actorAssetsRoot Stage-relative root of the pinned actor-appearance closure.
 * @property {string} modelAdapterRoot Stage-relative root of the Python inference adapter the model store installs into each family's venv.
 * @property {string} browserHarness Stage-relative path of the browser render harness.
 * @property {string} server Stage-relative path of the standalone Next server.
 * @property {string} hostEntry Stage-relative path of the local host launcher.
 * @property {string} workerEntry Stage-relative path of the bundled CPU worker.
 */

const STRING_FIELDS = /** @type {const} */ ([
  "platform", "arch", "target", "electron", "studioVersion", "nativeAddon", "nativeRuntimeRoot", "nativeRunner",
  "nativeRenderService", "nativeRenderLibrary", "actorAssetsRoot", "modelAdapterRoot", "browserHarness", "server",
  "hostEntry", "workerEntry",
]);

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Read and validate the manifest under `stageRoot`; a missing or foreign file
 * is an installation error, never a fall-through to workspace paths.
 * @param {string} stageRoot
 * @returns {Promise<StageManifest>}
 */
export async function readStageManifest(stageRoot) {
  const path = join(stageRoot, STAGE_MANIFEST_FILE);
  const incomplete = (/** @type {string} */ reason) => new Error(`${PRODUCT.name} resources are incomplete: ${path} ${reason}.`);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw incomplete(`is unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(parsed) || parsed.schema !== STAGE_MANIFEST_SCHEMA) throw incomplete(`is not a ${STAGE_MANIFEST_SCHEMA} document`);
  for (const field of STRING_FIELDS) {
    if (typeof parsed[field] !== "string") throw incomplete(`lacks "${field}"`);
  }
  if (parsed.gitRevision !== null && typeof parsed.gitRevision !== "string") throw incomplete('has a malformed "gitRevision"');
  const runtime = parsed.nativeRuntime;
  if (
    !isRecord(runtime) || typeof runtime.version !== "string" || typeof runtime.revision !== "string"
    || typeof runtime.archiveSha256 !== "string" || !Array.isArray(runtime.supportTiers)
  ) {
    throw incomplete('has a malformed "nativeRuntime"');
  }
  const tools = parsed.tools;
  if (!isRecord(tools) || typeof tools.ffmpeg !== "string" || typeof tools.ffprobe !== "string" || typeof tools.version !== "string" || typeof tools.license !== "string") {
    throw incomplete('has a malformed "tools"');
  }
  // Optional, because a manifest may predate them; malformed is still refused
  // so a consumer that verifies digests can trust the shape when present.
  if (tools.digests !== undefined
    && (!isRecord(tools.digests) || !/^[0-9a-f]{64}$/.test(String(tools.digests.ffmpeg)) || !/^[0-9a-f]{64}$/.test(String(tools.digests.ffprobe)))) {
    throw incomplete('has malformed "tools.digests"');
  }
  const bindings = parsed.nativeBindings;
  if (
    !isRecord(bindings)
    || !Object.values(bindings).every((packages) => isRecord(packages) && Object.values(packages).every((dir) => typeof dir === "string"))
  ) {
    throw incomplete('has a malformed "nativeBindings"');
  }
  // Every field was checked above.
  return /** @type {StageManifest} */ (parsed);
}

/**
 * The staged native pieces only run where they were built for.
 * @param {StageManifest} manifest
 */
export function assertStagePlatform(manifest) {
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(
      `This ${PRODUCT.name} build was staged for ${manifest.platform}-${manifest.arch} (${manifest.target}) and cannot run on ${process.platform}-${process.arch}; ` +
        "install the build for this platform.",
    );
  }
}

/** Native code file extensions per platform: a stage may hold only its own target's. */
const NATIVE_LIBRARY = Object.freeze({
  linux: /\.(node|so(\.\d+)*)$/,
  darwin: /\.(node|dylib)$/,
  win32: /\.(node|dll)$/,
});

/** Machine constants: ELF e_machine, Mach-O cputype, PE machine. */
const ELF_ARCH = Object.freeze({ 0x3e: "x64", 0xb7: "arm64" });
const MACHO_ARCH = Object.freeze({ 0x01000007: "x64", 0x0100000c: "arm64" });
const PE_ARCH = Object.freeze({ 0x8664: "x64", 0xaa64: "arm64" });

/**
 * Platform and architecture(s) an executable image was built for, read from
 * its header: ELF (Linux), Mach-O thin or fat (macOS), PE (Windows). Text,
 * scripts and data yield null.
 * @param {string} path
 * @returns {Promise<{ platform: NodeJS.Platform; archs: string[] } | null>}
 */
export async function binaryTarget(path) {
  const handle = await open(path, "r");
  const header = Buffer.alloc(4096);
  let length;
  try {
    ({ bytesRead: length } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  if (length < 64) return null;
  if (header.readUInt32BE(0) === 0x7f454c46) return { platform: "linux", archs: [ELF_ARCH[header.readUInt16LE(18)] ?? "unknown"] };
  const magic = header.readUInt32LE(0);
  if (magic === 0xfeedfacf) return { platform: "darwin", archs: [MACHO_ARCH[header.readUInt32LE(4)] ?? "unknown"] };
  if (header.readUInt32BE(0) === 0xcafebabe) {
    const count = header.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < count && 8 + i * 20 + 4 <= length; i += 1) archs.push(MACHO_ARCH[header.readUInt32BE(8 + i * 20)] ?? "unknown");
    return { platform: "darwin", archs };
  }
  if (header.readUInt16LE(0) === 0x5a4d) {
    const offset = header.readUInt32LE(0x3c);
    if (offset + 6 > length || header.readUInt32LE(offset) !== 0x00004550) return null;
    return { platform: "win32", archs: [PE_ARCH[header.readUInt16LE(offset + 4)] ?? "unknown"] };
  }
  return null;
}

const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

/**
 * SHA-256 of a thin 64-bit Mach-O image with its code signature removed:
 * the image `codesign` reads and rewrites when it (re)signs the file. Every
 * byte a signature does not own is covered; only the parts `codesign` itself
 * rewrites are normalised, each to the value an unsigned image holds:
 * - the header's `ncmds`/`sizeofcmds` with LC_CODE_SIGNATURE not counted, and
 *   that command's 16 bytes zeroed (codesign appends it as the last command
 *   into the zero padding after the load commands);
 * - `__LINKEDIT`'s `vmsize`/`filesize` zeroed (they grow by the signature);
 * - the file cut at the signature's `dataoff` (the signature is the trailing
 *   blob of `__LINKEDIT`; nothing may follow it), then zero-padded to the
 *   16-byte boundary codesign aligns a new signature to.
 * So a pinned unsigned or linker-ad-hoc-signed tool and the same tool after
 * `codesign --force` (ad-hoc or Developer ID, hardened runtime, entitlements)
 * hash alike, while any change to code, data, other load commands or the
 * link-edit tables, or any bytes smuggled beyond the signature, does not.
 * Throws for anything but a well-formed thin 64-bit Mach-O with at most one
 * trailing LC_CODE_SIGNATURE, so a fat, foreign or mangled file never has an
 * unsigned digest.
 * @param {Buffer} bytes whole file
 * @returns {{ sha256: string; signed: boolean }}
 */
export function unsignedMachO(bytes) {
  const malformed = (/** @type {string} */ reason) => new Error(`not a signable thin 64-bit Mach-O image: ${reason}`);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw malformed("bad magic");
  const ncmds = bytes.readUInt32LE(16);
  const sizeofcmds = bytes.readUInt32LE(20);
  const commandsEnd = 32 + sizeofcmds;
  if (commandsEnd > bytes.length) throw malformed("load commands exceed the file");
  let linkedit = -1;
  let signature = -1;
  for (let i = 0, offset = 32; i < ncmds; i += 1) {
    if (offset + 8 > commandsEnd) throw malformed("load commands overrun sizeofcmds");
    const cmd = bytes.readUInt32LE(offset);
    const cmdsize = bytes.readUInt32LE(offset + 4);
    if (cmdsize < 8 || offset + cmdsize > commandsEnd) throw malformed(`load command ${i} has size ${cmdsize}`);
    if (cmd === LC_SEGMENT_64 && cmdsize >= 56 && bytes.toString("latin1", offset + 8, offset + 24).replace(/\0+$/, "") === "__LINKEDIT") {
      if (linkedit !== -1) throw malformed("two __LINKEDIT segments");
      linkedit = offset;
    } else if (cmd === LC_CODE_SIGNATURE) {
      if (signature !== -1) throw malformed("two LC_CODE_SIGNATURE commands");
      if (cmdsize !== 16) throw malformed(`LC_CODE_SIGNATURE has size ${cmdsize}`);
      if (i !== ncmds - 1) throw malformed("LC_CODE_SIGNATURE is not the last load command");
      signature = offset;
    }
    offset += cmdsize;
  }
  if (linkedit === -1) throw malformed("no __LINKEDIT segment");
  if (signature !== -1 && signature < linkedit) throw malformed("LC_CODE_SIGNATURE precedes __LINKEDIT");
  let content = bytes.length;
  if (signature !== -1) {
    const dataoff = bytes.readUInt32LE(signature + 8);
    const datasize = bytes.readUInt32LE(signature + 12);
    const linkeditOffset = Number(bytes.readBigUInt64LE(linkedit + 40));
    if (dataoff < linkeditOffset || dataoff + datasize !== bytes.length) throw malformed("the code signature is not the trailing blob of __LINKEDIT");
    content = dataoff;
  }
  const header = Buffer.alloc(8);
  header.writeUInt32LE(signature === -1 ? ncmds : ncmds - 1, 0);
  header.writeUInt32LE(signature === -1 ? sizeofcmds : sizeofcmds - 16, 4);
  const zeros = Buffer.alloc(16);
  /** In file order: [offset, replacement] for every span a signature rewrites. */
  const replaced = [
    [16, header],
    [linkedit + 32, zeros.subarray(0, 8)], // vmsize
    [linkedit + 48, zeros.subarray(0, 8)], // filesize
  ];
  if (signature !== -1) replaced.push([signature, zeros]);
  const hash = createHash("sha256");
  let cursor = 0;
  for (const [offset, replacement] of replaced) {
    hash.update(bytes.subarray(cursor, offset));
    hash.update(replacement);
    cursor = offset + replacement.length;
  }
  hash.update(bytes.subarray(cursor, content));
  hash.update(zeros.subarray(0, (16 - (content % 16)) % 16));
  return { sha256: hash.digest("hex"), signed: signature !== -1 };
}

/**
 * npm's `os` / `cpu` / `libc` package fields: a list of allowed values, or a
 * list of `!excluded` values. Absent means unrestricted.
 * @param {unknown} field
 * @param {string} value
 */
function platformFieldAllows(field, value) {
  if (!Array.isArray(field) || field.length === 0) return true;
  const values = field.filter((entry) => typeof entry === "string");
  if (values.includes(`!${value}`)) return false;
  const allowed = values.filter((entry) => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value) || allowed.includes("any");
}

/**
 * Real directory Node's `require` picks for the bare package `name` from
 * `from`: the first `node_modules` lookup path holding it, exactly as at
 * runtime, independent of the package's `exports` map (sharp's `@img/*`
 * packages export no `./package.json`).
 * @param {string} from file whose resolution paths apply
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function resolvePackageDir(from, name) {
  for (const dir of createRequire(from).resolve.paths(name) ?? []) {
    const candidate = join(dir, name, "package.json");
    if ((await stat(candidate).catch(() => null))?.isFile()) return dirname(await realpath(candidate));
  }
  return null;
}

/**
 * Prove the staged host loads native code for its own target only:
 * - every per-target binding package the target needs resolves, from the
 *   dependency that loads it, to the directory the manifest records inside the
 *   stage, declares this platform/arch/libc and holds native code built for it;
 * - every executable and library the manifest names is built for the target;
 * - no package anywhere in the stage declares another platform, arch or libc,
 *   and no native code file anywhere in the stage was built for another target.
 * Pure path and header inspection: nothing is loaded, so the check runs on the
 * build host, in afterPack and on a finished package alike.
 * @param {string} stageRoot
 * @param {StageManifest} manifest
 * @returns {Promise<string[]>} problems; empty when the closure is complete
 */
export async function verifyNativeClosure(stageRoot, manifest) {
  /** @type {string[]} */
  const problems = [];
  const root = await realpath(stageRoot);
  const target = targetFor(manifest.platform, manifest.arch);
  const libc = manifest.platform === "linux" ? "glibc" : null;
  const library = NATIVE_LIBRARY[manifest.platform];
  const inside = (/** @type {string} */ path) => path === root || path.startsWith(root + sep);

  /** @param {string} path */
  const checkImage = async (path) => {
    const image = await binaryTarget(path).catch(() => null);
    const rel = relative(root, path);
    if (!image) problems.push(`${rel} is not an executable image`);
    else if (image.platform !== manifest.platform || !image.archs.includes(manifest.arch)) {
      problems.push(`${rel} is built for ${image.platform}-${image.archs.join("/")}, the stage targets ${manifest.platform}-${manifest.arch}`);
    }
  };

  const expected = Object.entries(target.bindings);
  const recorded = Object.keys(manifest.nativeBindings).sort();
  if (recorded.join(",") !== expected.map(([owner]) => owner).sort().join(",")) {
    problems.push(`manifest records native bindings for [${recorded.join(", ")}], the ${target.key} target needs [${expected.map(([owner]) => owner).join(", ")}]`);
  }
  for (const [owner, packages] of expected) {
    const recordedPackages = manifest.nativeBindings[owner] ?? {};
    const names = Object.keys(recordedPackages).sort();
    if (names.join(",") !== [...packages].sort().join(",")) {
      problems.push(`${owner}: manifest records binding packages [${names.join(", ")}], ${target.key} needs [${packages.join(", ")}]`);
      continue;
    }
    const ownerDir = await resolvePackageDir(join(root, manifest.server), owner);
    if (!ownerDir) {
      problems.push(`${owner} does not resolve from ${manifest.server}`);
      continue;
    }
    if (!inside(ownerDir)) {
      problems.push(`${owner} resolves outside the stage: ${ownerDir}`);
      continue;
    }
    for (const name of packages) {
      const recordedDir = join(root, recordedPackages[name]);
      const dir = await resolvePackageDir(join(ownerDir, "package.json"), name);
      if (!dir) {
        problems.push(`${owner} cannot resolve its ${target.key} binding ${name}; pnpm install on this platform did not provide it or the stage dropped it`);
        continue;
      }
      if (!inside(dir)) {
        problems.push(`${name} resolves outside the stage: ${dir}`);
        continue;
      }
      if (dir !== (await realpath(recordedDir).catch(() => null))) {
        problems.push(`${owner} resolves ${name} to ${relative(root, dir)}, the manifest records ${recordedPackages[name]}`);
      }
      let metadata;
      try {
        metadata = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      } catch {
        problems.push(`${name} has no readable package.json in the stage`);
        continue;
      }
      if (metadata.name !== name) problems.push(`${relative(root, dir)} is ${metadata.name}, not ${name}`);
      if (!platformFieldAllows(metadata.os, manifest.platform) || !platformFieldAllows(metadata.cpu, manifest.arch) || (libc && !platformFieldAllows(metadata.libc, libc))) {
        problems.push(`${name} declares os=${JSON.stringify(metadata.os)} cpu=${JSON.stringify(metadata.cpu)} libc=${JSON.stringify(metadata.libc)}, not ${target.key}${libc ? ` (${libc})` : ""}`);
      }
      const files = (await readdir(dir, { recursive: true }).catch(() => [])).filter((file) => library.test(file));
      if (files.length === 0) problems.push(`${name} holds no native code for ${manifest.platform} (${library})`);
      for (const file of files) await checkImage(join(dir, file));
    }
  }

  for (const rel of [
    manifest.nativeAddon, manifest.nativeRunner, manifest.nativeRenderService, manifest.nativeRenderLibrary, manifest.tools.ffmpeg, manifest.tools.ffprobe,
  ]) {
    const path = join(root, rel);
    if (!(await stat(path).catch(() => null))?.isFile()) problems.push(`${rel} is missing`);
    else await checkImage(path);
  }

  // Everything else in the stage, by npm metadata and by image header. Links
  // are not followed: every real directory is reached once and a POSIX stage
  // has already proven its links resolve inside it.
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.name === "package.json" && dir.split(sep).includes("node_modules")) {
        let metadata;
        try {
          metadata = JSON.parse(await readFile(path, "utf8"));
        } catch {
          continue;
        }
        if (!isRecord(metadata) || typeof metadata.name !== "string") continue;
        if (!platformFieldAllows(metadata.os, manifest.platform) || !platformFieldAllows(metadata.cpu, manifest.arch) || (libc && !platformFieldAllows(metadata.libc, libc))) {
          problems.push(`${relative(root, dir)} (${metadata.name}) is a package for os=${JSON.stringify(metadata.os)} cpu=${JSON.stringify(metadata.cpu)} libc=${JSON.stringify(metadata.libc)}, not ${target.key}`);
        }
      } else if (/\.(node|so(\.\d+)*|dylib|dll)$/.test(entry.name)) {
        if (!library.test(entry.name)) problems.push(`${relative(root, path)} is native code of another platform in a ${manifest.platform} stage`);
        else await checkImage(path);
      }
    }
  }
  return problems;
}
