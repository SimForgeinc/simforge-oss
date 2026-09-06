import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(await readFile(path.join(repoRoot, 'config/simforge-oss-stack.json'), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'simforge-packed-stack-'));
const tarballs = path.join(root, 'tarballs');
await mkdir(tarballs);

const dependencies = {};
for (const entry of config.packages) {
  const packageRoot = path.join(repoRoot, entry.path);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    stdio: 'pipe',
  });
  const archive = `${packageJson.name.slice(1).replace('/', '-')}-${packageJson.version}.tgz`;
  dependencies[packageJson.name] = `file:${path.join(tarballs, archive)}`;
}

await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
  name: 'simforge-packed-stack-smoke',
  private: true,
  type: 'module',
  dependencies,
}, null, 2)}\n`);

execFileSync('npm', [
  'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
], { cwd: root, stdio: 'pipe' });

const browserPackages = config.packages.filter((entry) => entry.role === 'studio-product-ui');
const names = config.packages.filter((entry) => entry.role !== 'studio-product-ui').map((entry) => entry.name);
const smokeScript = path.join(root, 'smoke-import.mjs');
await writeFile(smokeScript, [
  `const names = ${JSON.stringify(names)};`,
  'const verified = [];',
  'for (const name of names) {',
  '  const imported = await import(name);',
  '  verified.push({ name, exports: Object.keys(imported).length });',
  '}',
  'process.stdout.write(JSON.stringify(verified));',
  '',
].join('\n'));
const verified = JSON.parse(execFileSync(process.execPath, [smokeScript], {
  cwd: root,
  encoding: 'utf8',
}));

// Browser product entrypoints include client components, CSS and module
// workers. Exercise their real Next bundler rather than importing CSS in
// bare Node or silently omitting them from the packed-artifact check.
if (browserPackages.length > 0) {
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/layout.jsx'),
    'export default function Layout({children}) { return <html><body>{children}</body></html>; }\n');
  await writeFile(path.join(root, 'app/page.jsx'), [
    '"use client";',
    ...browserPackages.map((entry, index) => `import * as product${index} from ${JSON.stringify(entry.name)};`),
    `export default function Page() { return <pre>{JSON.stringify([${browserPackages.map((_, index) => `Object.keys(product${index})`).join(',')}])}</pre>; }`,
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'next.config.mjs'),
    `export default { transpilePackages: ${JSON.stringify(browserPackages.map((entry) => entry.name))} };\n`);
  const consumerRequire = createRequire(path.join(root, 'package.json'));
  execFileSync(process.execPath, [consumerRequire.resolve('next/dist/bin/next'), 'build', '--webpack'], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'pipe',
  });
  verified.push(...browserPackages.map((entry) => ({ name: entry.name, runtime: 'next-production-build' })));
}

await writeFile(path.join(root, 'smoke-result.json'), `${JSON.stringify({
  schema: 'simforge-oss.packed-stack-smoke/v1',
  stackVersion: config.stackVersion,
  verified,
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ root, stackVersion: config.stackVersion, verified }, null, 2)}\n`);
