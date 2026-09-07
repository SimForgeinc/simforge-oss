import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { childEnv } from "../../scripts/native-runtime/target-layout.mjs";
import { resolvePackageDir } from "./stage-manifest.mjs";

const executeFile = promisify(execFile);

/**
 * The trace selects package names, not source junctions. Next copies Windows
 * junction text into another tree where it can be invalid; resolve each root
 * against the original workspace's Node lookup scopes instead.
 * @param {string} tracedRoot
 * @param {string} sourceEntry original workspace importer
 * @returns {Promise<Array<[string, string]>>}
 */
export async function tracedDependencySources(tracedRoot, sourceEntry) {
  /** @type {Array<[string, string]>} */
  const sources = [];
  for (const entry of await readdir(tracedRoot, { withFileTypes: true })) {
    const names = entry.name.startsWith("@")
      ? (await readdir(join(tracedRoot, entry.name))).map((name) => `${entry.name}/${name}`)
      : [entry.name];
    for (const name of names) {
      if (!(await lstat(join(tracedRoot, name))).isSymbolicLink()) continue;
      const source = await resolvePackageDir(sourceEntry, name);
      if (!source) throw new Error(`Traced dependency ${name} is missing from the workspace`);
      sources.push([name, source]);
    }
  }
  return sources;
}

/**
 * Select and reserve an npm-resolvable scope without shadowing dependencies
 * already resolved through it. The caller records the chosen package in
 * placed before enqueueing its dependencies, so cycles reuse that location.
 * @param {string} name
 * @param {string} key canonical workspace package identity
 * @param {string[]} scopes nearest node_modules first
 * @param {Map<string, string>} placed location to package identity
 * @param {Map<string, Map<string, string>>} reserved scope to required name/identity
 * @returns {number} selected scope index
 */
export function reserveDependencyScope(name, key, scopes, placed, reserved) {
  let found = -1;
  let free = -1;
  for (let index = 0; index < scopes.length; index += 1) {
    const existing = placed.get(join(scopes[index], name));
    if (existing === key) {
      found = index;
      break;
    }
    if (existing !== undefined) break;
    const required = reserved.get(scopes[index])?.get(name);
    if (required !== undefined) {
      if (required !== key) break;
      continue;
    }
    free = index;
  }
  const index = found >= 0 ? found : free;
  if (index < 0) throw new Error(`${name} (${key}) cannot be placed beneath ${scopes[0]} without changing dependency resolution`);
  for (let nearer = 0; nearer < index; nearer += 1) {
    const names = reserved.get(scopes[nearer]) ?? new Map();
    names.set(name, key);
    reserved.set(scopes[nearer], names);
  }
  return index;
}

/**
 * Stage the published package, not workspace sources or development dependencies.
 * All tar paths are relative: GNU tar on Windows does not accept native drive
 * paths consistently. Extraction and the final rename stay on the target volume.
 * @param {{packageDir: string; repoRoot: string; stageRoot: string}} options
 * @returns {Promise<{metadata: Record<string, any>; target: string}>}
 */
export async function packWorkspacePackage({ packageDir, repoRoot, stageRoot }) {
  const packageRelative = relative(repoRoot, packageDir);
  if (packageRelative.startsWith("..") || isAbsolute(packageRelative)) throw new Error(`${packageDir} is outside the repository`);
  const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const target = join(stageRoot, packageRelative);
  await mkdir(dirname(target), { recursive: true });
  const packed = await mkdtemp(join(dirname(target), ".simforge-package-"));
  try {
    await executeFile("pnpm", ["pack", "--pack-destination", packed], {
      cwd: packageDir,
      env: childEnv(process.env, { npm_config_ignore_scripts: "true", pnpm_config_ignore_scripts: "true" }),
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const tarballs = (await readdir(packed)).filter((file) => file.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`${metadata.name} did not produce exactly one package archive`);
    const unpacked = join(packed, "unpacked");
    await mkdir(unpacked);
    await executeFile("tar", ["-xzf", `../${tarballs[0]}`, "--strip-components=1"], {
      cwd: unpacked,
      env: childEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    await rm(target, { recursive: true, force: true });
    await rename(unpacked, target);
  } finally {
    await rm(packed, { recursive: true, force: true });
  }
  return { metadata, target };
}
