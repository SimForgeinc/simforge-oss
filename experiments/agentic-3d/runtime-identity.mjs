/** Runtime identity of one authoring/replay process.
 *
 * Execution authority is the native SimForge runtime; the public packages are
 * façades and DTO/file-I/O boundaries over it. A frozen receipt therefore pins:
 *   - the actual loaded native addon (path, bytes, engine/ABI version),
 *   - the published artifacts of every public package this experiment imports,
 *   - the lockfile, the Blender renderer sources and the local authoring modules.
 * Nothing here labels a native façade as the former TypeScript engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@simforge-oss/engine';
import { runtimeIdentity as nativeRuntimeIdentity } from '@simforge-oss/engine/node';
import { assert, fileHash, hash } from './situation-authoring-resources.mjs';

export const RUNTIME_IDENTITY_SCHEMA = 'simforge.authoring-runtime-identity/v2';
const A3D = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(A3D, '..', '..');
const require = createRequire(import.meta.url);
/** Public packages whose published artifacts this experiment executes through. */
const PACKAGES = ['@simforge-oss/native-runtime', '@simforge-oss/engine', '@simforge-oss/compiler', '@simforge-oss/scenario', '@simforge-oss/maps', '@simforge-oss/asset-catalog'];
/** Published artifact extensions; sources, maps and type declarations are not executed. */
const ARTIFACT_FILE = /\.(?:js|mjs|cjs|node|wasm|json)$/;
const AUTHORING_MODULES = ['run-frozen-brief', 'situation-loop', 'situation-ensemble', 'situation-authoring-resources', 'situation-capabilities',
  'situation-sensing-policy', 'freeze-situation-sensing', 'geometry-binding', 'blender-client', 'gateway', 'asset-library', 'situation-nurec',
  'nurec-observations', 'situation-corpus', 'runtime-identity'];

function walk(root, relative, accept, out) {
  const pending = [relative];
  while (pending.length) {
    const directory = pending.pop();
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() && accept(name)) out.push(name);
    }
  }
  return out;
}
function packageRoot(specifier) {
  let directory = path.dirname(require.resolve(specifier));
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    assert(parent !== directory, `No package root for ${specifier}`);
    directory = parent;
  }
  return fs.realpathSync(directory);
}
/** Published artifacts of one public package: `package.json` plus every executable/data file under its declared `files`. */
function packageArtifacts(specifier) {
  const root = packageRoot(specifier);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(manifest.name === specifier, `Resolved ${specifier} to ${manifest.name}`);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, `${specifier} declares no published files`);
  const files = new Set(['package.json']);
  for (const pattern of manifest.files) {
    // `files` entries are directories, plain file names or `dir/*.ext` globs relative to the package root.
    const glob = pattern.indexOf('*');
    const entry = glob < 0 ? pattern : path.posix.dirname(pattern);
    const suffix = glob < 0 ? null : pattern.slice(pattern.lastIndexOf('*') + 1);
    const absolute = path.join(root, entry);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isDirectory()) walk(root, entry, name => ARTIFACT_FILE.test(name) && (suffix === null || name.endsWith(suffix)), []).forEach(name => files.add(name));
    else if (ARTIFACT_FILE.test(entry)) files.add(entry);
  }
  return { name: manifest.name, version: manifest.version, root, files: [...files].sort().map(name => ({ path: name, sha256: fileHash(path.join(root, name)) })) };
}
function nativeAddon() {
  const identity = nativeRuntimeIdentity();
  assert(typeof identity.addonPath === 'string' && fs.statSync(identity.addonPath).isFile(), 'Native runtime identity did not name a loaded addon file');
  // The façade reports the hash of the bytes it loaded; the file on disk must still be those bytes.
  assert(fileHash(identity.addonPath) === identity.addonSha256, `Native addon on disk differs from the loaded addon: ${identity.addonPath}`);
  return { addonPath: fs.realpathSync(identity.addonPath), addonSha256: identity.addonSha256, engineVersion: identity.engineVersion, abiVersion: identity.abiVersion,
    platform: process.platform, arch: process.arch };
}

/** Complete identity of the runtime executing this process; every entry is content-hashed. */
export function authoringRuntimeIdentity() {
  const local = [...AUTHORING_MODULES.map(name => `experiments/agentic-3d/${name}.mjs`),
    ...walk(ROOT, 'renderer/blender', name => /\.(?:py|js|html|css)$/.test(name) && !name.includes('/tests/'), [])].sort();
  const identity = { schema: RUNTIME_IDENTITY_SCHEMA, node: process.versions.node, native: nativeAddon(),
    packages: PACKAGES.map(packageArtifacts),
    lockfile: { path: 'pnpm-lock.yaml', sha256: fileHash(path.join(ROOT, 'pnpm-lock.yaml')) },
    local: local.map(name => ({ path: name, sha256: fileHash(path.join(ROOT, name)) })),
    scope: 'Loaded native addon bytes, published package artifacts, lockfile, renderer sources and local authoring modules. Renderer process identity, GPU state and gateway identity are attested separately.' };
  return { ...identity, digest: hash(canonicalJson(identity)) };
}

/** Files that changed since `identity` was captured; empty when the runtime is unchanged. */
export function changedRuntimeFiles(identity) {
  assert(identity?.schema === RUNTIME_IDENTITY_SCHEMA, 'Unsupported runtime identity schema');
  const changed = [];
  const check = (file, expected) => { if (!fs.existsSync(file) || fileHash(file) !== expected) changed.push(file); };
  check(identity.native.addonPath, identity.native.addonSha256);
  for (const pkg of identity.packages) for (const row of pkg.files) check(path.join(pkg.root, row.path), row.sha256);
  check(path.join(ROOT, identity.lockfile.path), identity.lockfile.sha256);
  for (const row of identity.local) check(path.join(ROOT, row.path), row.sha256);
  return changed;
}

/** Recompute and compare against a saved identity; a different runtime is a fact, not an error to hide. */
export function verifyRuntimeIdentity(identity) {
  const { digest, ...payload } = identity;
  assert(hash(canonicalJson(payload)) === digest, 'Runtime identity digest mismatch');
  const changed = changedRuntimeFiles(identity);
  const current = authoringRuntimeIdentity();
  return { unchanged: changed.length === 0 && current.digest === digest, changed, currentDigest: current.digest, recordedDigest: digest };
}
