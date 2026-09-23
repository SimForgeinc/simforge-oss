/**
 * Locate and run a pinned esmini build headless, CPU only.
 *
 * The harness never downloads anything. It uses, in order:
 *   1. `$SIMFORGE_ESMINI_BIN` (path to the `esmini` executable), or
 *   2. `<repo>/.tools/esmini/3.6.0/payload/esmini/bin/esmini`, which
 *      `packages/openscenario/scripts-esmini/fetch-pinned-esmini.mjs` installs
 *      from the digest-pinned official release archive.
 * When neither exists the caller reports "skipped", so CI without esmini stays
 * green instead of pretending to have checked anything.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ESMINI_FIXED_TIMESTEP_S = 0.02;

export interface EsminiBinary {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
}

export function locateEsmini(repoRoot: string, env: NodeJS.ProcessEnv = process.env): EsminiBinary | null {
  const candidates = [
    env['SIMFORGE_ESMINI_BIN'],
    path.join(repoRoot, '.tools', 'esmini', '3.6.0', 'payload', 'esmini', 'bin', 'esmini'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const sha256 = createHash('sha256').update(readFileSync(candidate)).digest('hex');
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const tag = /esmini GIT TAG:\s*(\S+)/.exec(`${probe.stdout}${probe.stderr}`)?.[1] ?? 'unknown';
    return { path: candidate, sha256, version: tag };
  }
  return null;
}

export interface EsminiRun {
  readonly exitCode: number | null;
  readonly csv: string;
  readonly log: string;
  readonly stderr: string;
}

/**
 * `--traj_filter 0` keeps every trajectory vertex (the default merges points
 * closer than 0.1 m, which would silently resample trajectory-replay files).
 */
export interface EsminiRunOptions {
  readonly timeoutMs?: number;
  /**
   * esmini's polyline orientation mode. Our trajectory-replay files write the
   * body heading on every vertex; esmini 3.6.0 predates the OSC 1.4
   * `Interpolation` element and by default ("corner") averages headings at
   * vertices, so the round trip replays with "segment", which keeps them.
   */
  readonly polylineInterpolation?: 'corner' | 'segment' | 'off';
}

export function runEsmini(binary: EsminiBinary, xoscPath: string, workDir: string, options: EsminiRunOptions = {}): EsminiRun {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const csvPath = path.join(workDir, 'esmini.csv');
  const logPath = path.join(workDir, 'esmini.log');
  const result = spawnSync(binary.path, [
    '--osc', xoscPath,
    '--headless',
    '--fixed_timestep', String(ESMINI_FIXED_TIMESTEP_S),
    '--traj_filter', '0',
    '--collision',
    '--csv_logger', csvPath,
    '--logfile_path', logPath,
    '--disable_stdout',
    ...(options.polylineInterpolation ? ['--pline_interpolation', options.polylineInterpolation] : []),
  ], { cwd: workDir, encoding: 'utf8', timeout: timeoutMs });
  return {
    exitCode: result.status,
    csv: existsSync(csvPath) ? readFileSync(csvPath, 'utf8') : '',
    log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
    stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
  };
}
