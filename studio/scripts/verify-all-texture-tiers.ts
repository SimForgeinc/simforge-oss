/** Run the complete real-daemon matrix without concealing an earlier failure.
 * pnpm verify:all-texture-tiers --root=<production daemon on5514–5517>
 *   --scenario=<Belmont RGB scenario> --ml-scenario=<Garching RGB scenario>
 *   --texture-url=<Belmont master KTX2>
 * Fresh worktree: node studio/scripts/sync-studio-assets.mjs before daemon boot;
 * link/build native-runtime native/wasm/dist prerequisites. Do not reuse a live
 * user's data root. All processes launched by individual gates close in finally.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2);
assert(args.some(arg => arg.startsWith('--root=')) && args.some(arg => arg.startsWith('--scenario='))
  && args.some(arg => arg.startsWith('--ml-scenario=')) && args.some(arg => arg.startsWith('--texture-url=')), '--root, --scenario, --ml-scenario and --texture-url are required');
const mlScenario = args.find(arg => arg.startsWith('--ml-scenario='))!.slice('--ml-scenario='.length);
const root = resolve(args.find(arg => arg.startsWith('--root='))!.slice('--root='.length));
const out = resolve(args.find(arg => arg.startsWith('--out='))?.slice('--out='.length) ?? join(root, 'texture-tier-matrix'));
assert(![root, out].some(path => path === '/home/path/.local/share/simforge/daemon-data' || path.startsWith('/home/path/.local/share/simforge/daemon-data/')), 'live daemon root is forbidden');
await mkdir(out, { recursive: true });
const forwarded = args.filter(arg => !arg.startsWith('--out='));
const matrix = [
  { name: 'calibration', file: 'texture-tier-assertions.test.ts', args: ['--test'] },
  { name: 'frame-readability-calibration', file: 'texture-frame-quality.test.ts', args: ['--test'] },
  { name: 'viewer-context-lifetime', file: 'verify-viewer-context-lifetime.ts', args: [] },
  { name: 'container-dedup', file: 'verify-texture-container-reuse.ts', args: [] },
  { name: 'low', file: 'verify-texture-tiers.ts', args: ['--tier=low'] },
  { name: 'medium', file: 'verify-texture-tiers.ts', args: ['--tier=medium'] },
  { name: 'medium-portable', file: 'verify-texture-tiers.ts', args: ['--tier=medium', '--capabilities=portable'] },
  { name: 'medium-restricted', file: 'verify-texture-tiers.ts', args: ['--tier=medium', '--capabilities=restricted'] },
  { name: 'render', file: 'verify-native-texture-tiers.ts', args: ['--profile=render'] },
  { name: 'garching-full-refusal', file: 'verify-native-texture-tiers.ts', args: ['--profile=render', '--expect-capacity-refusal=true', `--scenario=${mlScenario}`] },
  { name: 'ml', file: 'verify-native-texture-tiers.ts', args: ['--profile=ml', `--scenario=${mlScenario}`] },
];
const failures: string[] = [];
const results: { name: string; exit: number; seconds: number; output: string | null }[] = [];
for (const gate of matrix) {
  const started = performance.now();
  const launch = ['--import', 'tsx', '--conditions=development'];
  if (gate.file.endsWith('.test.ts')) launch.push('--test');
  launch.push(join(import.meta.dirname, gate.file));
  const output = gate.file.endsWith('.test.ts') ? null
    : join(out, gate.name + (['viewer-context-lifetime', 'container-dedup'].includes(gate.name) ? '.json' : ''));
  if (output) launch.push(...forwarded, ...gate.args, `--out=${output}`);
  const child = spawn(process.execPath, launch, { stdio: 'inherit' });
  const exit = Promise.withResolvers<number>();
  child.once('error', error => { console.error(error); exit.resolve(1); });
  child.once('exit', (code, signal) => exit.resolve(signal ? 1 : code ?? 1));
  const code = await exit.promise;
  const result = { name: gate.name, exit: code, seconds: (performance.now() - started) / 1000, output };
  results.push(result);
  await writeFile(join(out, 'matrix.json'), JSON.stringify({ root, results }, null, 2));
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} matrix/${gate.name}: ${JSON.stringify(result)}`);
  if (code !== 0) failures.push(gate.name);
}
assert.equal(failures.length, 0, `tier matrix failed: ${failures.join(', ')}`);
