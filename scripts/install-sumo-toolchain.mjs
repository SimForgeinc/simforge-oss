#!/usr/bin/env node
/**
 * Install the pinned SUMO toolchain used to build map SUMO derivatives.
 *
 *   pnpm maps:sumo:toolchain                      # into $XDG_DATA_HOME/simforge/toolchains/sumo-1.27.1
 *   pnpm maps:sumo:toolchain -- --root /opt/sumo  # anywhere; then SIMFORGE_SUMO_TOOLCHAIN=/opt/sumo
 *
 * A Python virtual environment receives eclipse-sumo from PyPI with every
 * wheel digest pinned (config/sumo-toolchain.json, --require-hashes), and the
 * result is accepted only when netconvert reports exactly the pinned version.
 * Re-running is idempotent. stdout is one JSON document.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveSumoToolchain, SUMO_VERSION } from '../packages/map-pipeline/scripts/sumo-network.mjs';

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const config = JSON.parse(await readFile(path.join(repository, 'config', 'sumo-toolchain.json'), 'utf8'));
if (config.sumo !== SUMO_VERSION) throw new Error(`config/sumo-toolchain.json pins ${config.sumo}, the derivative builder requires ${SUMO_VERSION}`);
const root = path.resolve(option('root', path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'toolchains', `sumo-${SUMO_VERSION}`)));
const python = path.join(root, 'bin', 'python');

try {
  if (!existsSync(python)) {
    await mkdir(path.dirname(root), { recursive: true });
    await run(option('python', 'python3'), ['-m', 'venv', root], { maxBuffer: 16 * 1024 * 1024 });
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'simforge-sumo-toolchain-'));
  try {
    const requirements = Object.entries(config.requirements)
      .map(([requirement, hashes]) => `${requirement} ${hashes.map((hash) => `--hash=${hash}`).join(' ')}`).join('\n');
    const file = path.join(scratch, 'requirements.txt');
    await writeFile(file, `${requirements}\n`);
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--require-hashes', '--only-binary', ':all:', '-r', file], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const toolchain = await resolveSumoToolchain({ env: { ...process.env, SIMFORGE_SUMO_TOOLCHAIN: root, SIMFORGE_SUMO_BIN: '' }, repository });
  process.stdout.write(`${JSON.stringify({ schema: 'simforge.sumo-toolchain.v1', version: toolchain.version, root, netconvert: toolchain.netconvert, fingerprint: toolchain.fingerprint, use: `SIMFORGE_SUMO_TOOLCHAIN=${root}` }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: 'sumo_toolchain_install_failed', reason: error instanceof Error ? error.message : String(error), detail: { root } })}\n`);
  process.exit(1);
}
