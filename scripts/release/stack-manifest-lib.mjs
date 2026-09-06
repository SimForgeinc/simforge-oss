import { execFileSync } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const NPM_SCOPE = '@simforge-oss/';
const PYPI_PREFIX = 'simforge-oss-';
const WORKSPACE_PACKAGES_DIR = 'packages';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function currentRevision(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function internalDependencies(packageJson) {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  return Object.entries(Object.fromEntries(
    sections.flatMap((section) => Object.entries(packageJson[section] ?? {})),
  )).filter(([name]) => name.startsWith(NPM_SCOPE));
}

function normalizedPythonVersion(stackVersion) {
  return stackVersion.replace(/-rc\.(\d+)$/u, 'rc$1');
}

function assertRegistry(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`stack config must declare at least one ${label}`);
  }
  const names = new Set();
  const paths = new Set();
  for (const entry of entries) {
    for (const field of ['name', 'version', 'path', 'role']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`stack config ${label} entries must declare ${field}; found ${JSON.stringify(entry)}`);
      }
    }
    if (names.has(entry.name)) throw new Error(`stack config ${label} ${entry.name} is registered twice`);
    if (paths.has(entry.path)) throw new Error(`stack config ${label} path ${entry.path} is registered twice`);
    names.add(entry.name);
    paths.add(entry.path);
  }
}

/** Splits a pyproject.toml into `{ [table]: body }` without a TOML parser. */
function tomlTables(source) {
  const tables = new Map();
  let current = '';
  for (const line of source.split('\n')) {
    const header = line.match(/^\[([^\]]+)\]\s*$/u);
    if (header) {
      current = header[1].trim();
      if (!tables.has(current)) tables.set(current, []);
      continue;
    }
    if (!tables.has(current)) tables.set(current, []);
    tables.get(current).push(line);
  }
  return new Map([...tables].map(([table, lines]) => [table, lines.join('\n')]));
}

function tomlString(body, key) {
  return body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'mu'))?.[1];
}

const REQUIREMENT = /"(simforge-oss-[a-z0-9-]+)(\[[^\]]*\])?\s*([^"]*)"/gu;
const REQUIREMENT_ARRAY = /^[\w-]+\s*=\s*\[([\s\S]*?)\]/gmu;

/** Requirement strings from `[project] dependencies` and every `[project.optional-dependencies]` extra. */
function internalRequirements(tables) {
  const project = tables.get('project') ?? '';
  const arrays = [
    project.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/mu)?.[1] ?? '',
    ...[...(tables.get('project.optional-dependencies') ?? '').matchAll(REQUIREMENT_ARRAY)].map(([, body]) => body),
  ];
  return arrays.flatMap((body) => [...body.matchAll(REQUIREMENT)].map(([, name, , specifier]) => ({
    name,
    specifier: specifier.trim(),
  })));
}

function uvSources(tables) {
  const body = tables.get('tool.uv.sources') ?? '';
  return [...body.matchAll(/^(simforge-oss-[a-z0-9-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/gmu)]
    .map(([, name, sourcePath]) => ({ name, sourcePath }));
}

async function pythonPackages(repoRoot, config) {
  const entries = config.pythonPackages ?? [];
  if (entries.length === 0) return [];
  assertRegistry(entries, 'Python package');
  const expectedVersion = normalizedPythonVersion(config.stackVersion);
  const registered = new Map(entries.map((entry) => [entry.name, entry]));
  const projects = [];
  for (const entry of entries) {
    if (entry.registry !== 'pypi') {
      throw new Error(`${entry.path} must publish through PyPI`);
    }
    if (!entry.name.startsWith(PYPI_PREFIX)) {
      throw new Error(`${entry.path} must declare a ${PYPI_PREFIX}* distribution name`);
    }
    const tables = tomlTables(await readFile(path.join(repoRoot, entry.path, 'pyproject.toml'), 'utf8'));
    const project = tables.get('project') ?? '';
    const name = tomlString(project, 'name');
    const version = tomlString(project, 'version');
    if (name !== entry.name || version !== entry.version) {
      throw new Error(`${entry.path} PyPI identity must equal ${entry.name} ${entry.version}`);
    }
    if (version !== expectedVersion) {
      throw new Error(`${entry.name} must use the PEP 440 form of stack version ${config.stackVersion}; found ${version}`);
    }
    if (tomlString(project, 'license') !== 'Apache-2.0') {
      throw new Error(`${entry.name} must declare the Apache-2.0 license`);
    }
    if (!tables.get('build-system')?.includes('build-backend')) {
      throw new Error(`${entry.name} must declare a PEP 517 build backend`);
    }
    projects.push({ entry, tables });
  }

  for (const { entry, tables } of projects) {
    for (const requirement of internalRequirements(tables)) {
      const target = registered.get(requirement.name);
      if (!target) {
        throw new Error(`${entry.name} depends on ${requirement.name}, which is not registered in the stack config`);
      }
      if (requirement.specifier !== `==${target.version}`) {
        throw new Error(`${entry.name} must pin ${requirement.name} to ==${target.version}; found "${requirement.specifier}"`);
      }
    }
    for (const { name, sourcePath } of uvSources(tables)) {
      const target = registered.get(name);
      if (!target) {
        throw new Error(`${entry.name} resolves ${name} from a workspace path but ${name} is not registered in the stack config`);
      }
      const resolved = path.posix.normalize(path.posix.join(entry.path, sourcePath));
      if (resolved !== target.path) {
        throw new Error(`${entry.name} resolves ${name} from ${resolved}; the stack config registers ${target.path}`);
      }
    }
  }

  return projects.map(({ entry }) => ({
    name: entry.name,
    version: entry.version,
    role: entry.role,
    ecosystem: 'pypi',
  }));
}

function assertCompiledPackage(packageJson) {
  if (packageJson.main !== './dist/index.js' || packageJson.types !== './dist/index.d.ts') {
    throw new Error(`${packageJson.name} must publish compiled dist entry points`);
  }
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes('dist')) {
    throw new Error(`${packageJson.name} must include dist in published files`);
  }
  const rootExport = packageJson.exports?.['.'];
  if (rootExport?.default !== './dist/index.js' || rootExport?.types !== './dist/index.d.ts') {
    throw new Error(`${packageJson.name} must expose compiled root exports`);
  }
  for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
    if (typeof target !== 'string' || target.includes('/src/') || target.endsWith('.ts')) {
      throw new Error(`${packageJson.name} binary ${name} must not execute TypeScript source`);
    }
  }
}

async function assertNoUnregisteredPublishable(repoRoot, registeredPaths) {
  const packagesDir = path.join(repoRoot, WORKSPACE_PACKAGES_DIR);
  let directories;
  try {
    directories = await readdir(packagesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const dirent of directories) {
    if (!dirent.isDirectory()) continue;
    const packagePath = `${WORKSPACE_PACKAGES_DIR}/${dirent.name}`;
    if (registeredPaths.has(packagePath)) continue;
    const manifestFile = path.join(packagesDir, dirent.name, 'package.json');
    try {
      await access(manifestFile);
    } catch {
      continue;
    }
    const packageJson = await readJson(manifestFile);
    if (packageJson.private === true) continue;
    throw new Error(`${packagePath} (${packageJson.name}) is publishable but not registered in the stack config`);
  }
}

export async function buildStackManifest({ repoRoot, sourceRevision } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');

  const config = await readJson(path.join(repoRoot, 'config/simforge-oss-stack.json'));
  if (config.schema !== 'simforge-oss.stack-config/v1') {
    throw new Error(`Unsupported stack config schema: ${String(config.schema)}`);
  }

  const revision = sourceRevision ?? currentRevision(repoRoot);
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`source revision must be a full lowercase git SHA: ${revision}`);
  }
  if (
    config.actorAssets?.schema !== 'simforge.actor-assets-closure/v1'
    || !/^[0-9a-f]{64}$/u.test(config.actorAssets.digest ?? '')
    || !URL.canParse(config.actorAssets.baseUrl ?? '')
  ) {
    throw new Error('stack config must pin a valid actor asset closure');
  }

  assertRegistry(config.packages, 'npm package');
  await assertNoUnregisteredPublishable(repoRoot, new Set(config.packages.map((entry) => entry.path)));

  const packages = [];
  const manifests = [];
  const versions = new Map();
  for (const entry of config.packages) {
    const packageJson = await readJson(path.join(repoRoot, entry.path, 'package.json'));
    if (typeof packageJson.name !== 'string' || !packageJson.name.startsWith(NPM_SCOPE)) {
      throw new Error(`${entry.path} must declare an ${NPM_SCOPE}* package name`);
    }
    if (packageJson.name !== entry.name || packageJson.version !== entry.version) {
      throw new Error(`${entry.path} identity must equal ${entry.name} ${entry.version}`);
    }
    if (packageJson.version !== config.stackVersion) {
      throw new Error(`${packageJson.name} must use stack version ${config.stackVersion}`);
    }
    if (packageJson.private === true) {
      throw new Error(`${packageJson.name} is private and cannot be part of the public stack`);
    }
    if (packageJson.license !== 'Apache-2.0') {
      throw new Error(`${packageJson.name} must declare the Apache-2.0 license`);
    }
    if (packageJson.publishConfig?.access !== 'public' || packageJson.publishConfig?.provenance !== true) {
      throw new Error(`${packageJson.name} must publish publicly with npm provenance`);
    }
    if (packageJson.repository?.directory !== entry.path) {
      throw new Error(`${packageJson.name} repository.directory must be ${entry.path}`);
    }
    assertCompiledPackage(packageJson);
    versions.set(packageJson.name, packageJson.version);
    manifests.push(packageJson);
    packages.push({
      name: packageJson.name,
      version: packageJson.version,
      role: entry.role,
    });
  }

  for (const packageJson of manifests) {
    for (const [name, range] of internalDependencies(packageJson)) {
      const expected = versions.get(name);
      if (!expected) {
        throw new Error(`${packageJson.name} depends on ${name}, which is not registered in the stack config`);
      }
      if (range !== 'workspace:*' && range !== `workspace:${expected}` && range !== expected) {
        throw new Error(`${packageJson.name} must pin ${name} to the stack version ${expected}; found ${range}`);
      }
    }
  }

  return {
    schema: 'simforge-oss.stack/v1',
    stackVersion: config.stackVersion,
    source: {
      repository: config.repository,
      revision,
    },
    contracts: config.contracts,
    actorAssets: config.actorAssets,
    packages,
    pythonPackages: await pythonPackages(repoRoot, config),
  };
}

export function serializeStackManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
