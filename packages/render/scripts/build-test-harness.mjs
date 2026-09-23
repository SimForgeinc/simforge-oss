// Vitest global setup: build the browser render harness (dist/harness.html +
// dist/web/headless.js + basis transcoder) before the suite runs.
//
// `src/web/engine.test.ts` boots the real harness in headless Chromium through
// the default resolution the worker uses, and that harness is a build output.
// It bundles workspace packages from source (tsup.browser.config.ts), so this
// needs no dist/ of any other package and takes about a second; building every
// run keeps the harness from going stale against the sources under test.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(import.meta.url);
  const tsup = join(dirname(require.resolve('tsup/package.json')), require('tsup/package.json').bin.tsup);
  const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  run([tsup, '--config', 'tsup.browser.config.ts', '--silent']);
  run(['scripts/copy-dist-assets.mjs']);
}
