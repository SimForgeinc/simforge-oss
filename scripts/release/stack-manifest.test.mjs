import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStackManifest, serializeStackManifest } from './stack-manifest-lib.mjs';

const SHA = 'a'.repeat(40);

const PACKAGE_NAMES = ['scenario', 'native-runtime', 'engine', 'studio-ui'];

const DEPENDENCIES = {
  engine: { '@simforge-oss/scenario': 'workspace:*', '@simforge-oss/native-runtime': 'workspace:*' },
  'studio-ui': { '@simforge-oss/engine': 'workspace:*' },
};

function npmManifest(name, overrides = {}) {
  const directory = `packages/${name}`;
  return {
    name: `@simforge-oss/${name}`, version: '1.2.3', license: 'Apache-2.0',
    main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    publishConfig: { access: 'public', provenance: true },
    repository: { directory },
    ...(DEPENDENCIES[name] ? { dependencies: DEPENDENCIES[name] } : {}),
    ...overrides,
  };
}

function pyproject({ name, version = '1.2.3rc4', requirements = [], sources = {} }) {
  const lines = [
    '[build-system]',
    'requires = ["hatchling>=1.25"]',
    'build-backend = "hatchling.build"',
    '',
    '[project]',
    `name = "${name}"`,
    `version = "${version}"`,
    'license = "Apache-2.0"',
    'dependencies = ["numpy>=1.26"]',
    '',
    '[project.optional-dependencies]',
    `extra = [${requirements.map((item) => `"${item}"`).join(', ')}]`,
    '',
    '[project.urls]',
    'Repository = "https://example.test/simforge"',
  ];
  const sourceEntries = Object.entries(sources);
  if (sourceEntries.length) {
    lines.push('', '[tool.uv.sources]', ...sourceEntries.map(([dep, dir]) => `${dep} = { path = "${dir}" }`));
  }
  return `${lines.join('\n')}\n`;
}

async function fixture({ overrides = {}, stackVersion = '1.2.3', pythonPackages, pyprojects = {}, extraPackages = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'simforge-stack-'));
  const config = {
    schema: 'simforge-oss.stack-config/v1',
    stackVersion,
    repository: 'https://example.test/simforge',
    contracts: { scenarioTemplate: '2', simulationStepSeconds: 0.02 },
    actorAssets: {
      schema: 'simforge.actor-assets-closure/v1',
      digest: 'b'.repeat(64),
      baseUrl: 'https://assets.example.test',
    },
    packages: PACKAGE_NAMES.map((name) => ({
      name: `@simforge-oss/${name}`,
      version: stackVersion,
      path: `packages/${name}`,
      role: `${name}-role`,
    })),
    ...(pythonPackages ? { pythonPackages } : {}),
  };
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config/simforge-oss-stack.json'), JSON.stringify(config));
  for (const name of PACKAGE_NAMES) {
    await mkdir(path.join(root, `packages/${name}`), { recursive: true });
    await writeFile(
      path.join(root, `packages/${name}/package.json`),
      JSON.stringify(npmManifest(name, { version: stackVersion, ...overrides[name] })),
    );
  }
  for (const [name, manifest] of Object.entries(extraPackages)) {
    await mkdir(path.join(root, `packages/${name}`), { recursive: true });
    await writeFile(path.join(root, `packages/${name}/package.json`), JSON.stringify(manifest));
  }
  for (const [directory, source] of Object.entries(pyprojects)) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'pyproject.toml'), source);
  }
  return root;
}

test('builds a deterministic stack manifest from the declared registry', async () => {
  const repoRoot = await fixture();
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.equal(manifest.source.revision, SHA);
  assert.equal(manifest.schema, 'simforge-oss.stack/v1');
  assert.deepEqual(manifest.packages, PACKAGE_NAMES.map((name) => ({
    name: `@simforge-oss/${name}`, version: '1.2.3', role: `${name}-role`,
  })));
  assert.deepEqual(manifest.pythonPackages, []);
  assert.deepEqual(manifest.actorAssets, {
    schema: 'simforge.actor-assets-closure/v1',
    digest: 'b'.repeat(64),
    baseUrl: 'https://assets.example.test',
  });
  assert.equal(serializeStackManifest(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('rejects an empty or duplicated npm registry', async () => {
  const emptyRoot = await fixture();
  const configPath = path.join(emptyRoot, 'config/simforge-oss-stack.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(configPath, JSON.stringify({ ...config, packages: [] }));
  await assert.rejects(
    buildStackManifest({ repoRoot: emptyRoot, sourceRevision: SHA }),
    /must declare at least one npm package/u,
  );

  const duplicateRoot = await fixture();
  const duplicatePath = path.join(duplicateRoot, 'config/simforge-oss-stack.json');
  const duplicate = JSON.parse(await readFile(duplicatePath, 'utf8'));
  duplicate.packages.push({ ...duplicate.packages[0], path: 'packages/other' });
  await writeFile(duplicatePath, JSON.stringify(duplicate));
  await assert.rejects(
    buildStackManifest({ repoRoot: duplicateRoot, sourceRevision: SHA }),
    /@simforge-oss\/scenario is registered twice/u,
  );
});

test('rejects internal npm dependencies that are absent from the registry', async () => {
  const repoRoot = await fixture({ overrides: { engine: {
    dependencies: { '@simforge-oss/scenario': 'workspace:*', '@simforge-oss/hidden-kernel': 'workspace:*' },
  } } });
  await assert.rejects(
    buildStackManifest({ repoRoot, sourceRevision: SHA }),
    /@simforge-oss\/engine depends on @simforge-oss\/hidden-kernel, which is not registered/u,
  );
});

test('rejects publishable workspace packages that are not registered', async () => {
  const publishable = await fixture({ extraPackages: { orphan: npmManifest('orphan') } });
  await assert.rejects(
    buildStackManifest({ repoRoot: publishable, sourceRevision: SHA }),
    /packages\/orphan \(@simforge-oss\/orphan\) is publishable but not registered/u,
  );

  const privateRoot = await fixture({ extraPackages: { orphan: { ...npmManifest('orphan'), private: true } } });
  await buildStackManifest({ repoRoot: privateRoot, sourceRevision: SHA });
});

test('binds PyPI packages to the PEP 440 stack version and exact internal pins', async () => {
  const pythonPackages = [
    { path: 'adapters/gym', name: 'simforge-oss-gym', version: '1.2.3rc4', role: 'python-sdk', registry: 'pypi' },
    { path: 'adapters/physics', name: 'simforge-oss-physics', version: '1.2.3rc4', role: 'physics-profile', registry: 'pypi' },
  ];
  const repoRoot = await fixture({
    stackVersion: '1.2.3-rc.4',
    pythonPackages,
    pyprojects: {
      'adapters/gym': pyproject({
        name: 'simforge-oss-gym',
        requirements: ['simforge-oss-physics[warp]==1.2.3rc4'],
        sources: { 'simforge-oss-physics': '../physics' },
      }),
      'adapters/physics': pyproject({ name: 'simforge-oss-physics' }),
    },
  });
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.deepEqual(manifest.pythonPackages, [
    { name: 'simforge-oss-gym', version: '1.2.3rc4', role: 'python-sdk', ecosystem: 'pypi' },
    { name: 'simforge-oss-physics', version: '1.2.3rc4', role: 'physics-profile', ecosystem: 'pypi' },
  ]);
});

test('rejects PyPI packages whose version or internal pins drift from the stack', async () => {
  const pythonPackages = [
    { path: 'adapters/gym', name: 'simforge-oss-gym', version: '1.2.3rc4', role: 'python-sdk', registry: 'pypi' },
    { path: 'adapters/physics', name: 'simforge-oss-physics', version: '1.2.3rc4', role: 'physics-profile', registry: 'pypi' },
  ];
  const cases = [
    {
      pattern: /simforge-oss-physics must use the PEP 440 form of stack version 1\.2\.3-rc\.4; found 0\.1\.0/u,
      pythonPackages: pythonPackages.map((entry) => (entry.name === 'simforge-oss-physics' ? { ...entry, version: '0.1.0' } : entry)),
      pyprojects: {
        'adapters/gym': pyproject({ name: 'simforge-oss-gym', requirements: ['simforge-oss-physics==1.2.3rc4'] }),
        'adapters/physics': pyproject({ name: 'simforge-oss-physics', version: '0.1.0' }),
      },
    },
    {
      pattern: /simforge-oss-gym must pin simforge-oss-physics to ==1\.2\.3rc4; found ">=0\.1\.0"/u,
      pyprojects: {
        'adapters/gym': pyproject({ name: 'simforge-oss-gym', requirements: ['simforge-oss-physics>=0.1.0'] }),
        'adapters/physics': pyproject({ name: 'simforge-oss-physics' }),
      },
    },
    {
      pattern: /simforge-oss-gym depends on simforge-oss-splat, which is not registered/u,
      pyprojects: {
        'adapters/gym': pyproject({ name: 'simforge-oss-gym', requirements: ['simforge-oss-splat==1.2.3rc4'] }),
        'adapters/physics': pyproject({ name: 'simforge-oss-physics' }),
      },
    },
    {
      pattern: /simforge-oss-gym resolves simforge-oss-physics from vendor\/physics; the stack config registers adapters\/physics/u,
      pyprojects: {
        'adapters/gym': pyproject({
          name: 'simforge-oss-gym',
          requirements: ['simforge-oss-physics==1.2.3rc4'],
          sources: { 'simforge-oss-physics': '../../vendor/physics' },
        }),
        'adapters/physics': pyproject({ name: 'simforge-oss-physics' }),
      },
    },
  ];
  for (const item of cases) {
    const repoRoot = await fixture({
      stackVersion: '1.2.3-rc.4',
      pythonPackages: item.pythonPackages ?? pythonPackages,
      pyprojects: item.pyprojects,
    });
    await assert.rejects(buildStackManifest({ repoRoot, sourceRevision: SHA }), item.pattern);
  }
});

test('rejects private packages and version-skewed internal dependencies', async () => {
  const privateRoot = await fixture({ overrides: { scenario: { private: true } } });
  await assert.rejects(
    buildStackManifest({ repoRoot: privateRoot, sourceRevision: SHA }),
    /private and cannot be part of the public stack/u,
  );

  const skewedRoot = await fixture({ overrides: { engine: { dependencies: { '@simforge-oss/scenario': '^1.2.3' } } } });
  await assert.rejects(
    buildStackManifest({ repoRoot: skewedRoot, sourceRevision: SHA }),
    /must pin @simforge-oss\/scenario to the stack version 1.2.3/u,
  );
});

test('requires a full immutable source revision', async () => {
  const repoRoot = await fixture();
  await assert.rejects(
    buildStackManifest({ repoRoot, sourceRevision: 'main' }),
    /full lowercase git SHA/u,
  );
});

test('rejects packages that publish TypeScript source instead of release artifacts', async () => {
  const repoRoot = await fixture({ overrides: { scenario: {
    main: './src/index.ts',
    types: './src/index.ts',
    files: ['src'],
    exports: { '.': './src/index.ts' },
  } } });
  await assert.rejects(
    buildStackManifest({ repoRoot, sourceRevision: SHA }),
    /must publish compiled dist entry points/u,
  );
});
