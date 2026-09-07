import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageDir } from "./stage-manifest.mjs";

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
