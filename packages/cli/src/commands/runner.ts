/**
 * `simforge job …`, `simforge worker …`, `simforge cas …`, `simforge runtime show`.
 *
 * Durable execution lives in the native runner binary (`simforge-runner`):
 * jobs, checkpoints, the content store and the worker are its state, never
 * this process's. These commands only locate the binary and hand it the
 * argv unchanged, so the runner's contract is the contract - stdout is one
 * JSON document (`job attach` streams JSON lines), stderr carries the
 * structured error, and the exit code passes through.
 *
 * Discovery order: `$SIMFORGE_RUNNER_BIN`, then the installed native runtime
 * root (`${SIMFORGE_NATIVE_RUNTIME_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime}/bin/simforge-runner`),
 * then `simforge-runner` on `PATH`. The binary ships in the native runtime
 * tarball, not in an npm package, so a missing binary is an installation error.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { CliError, EXIT } from '../errors.js';

export const RUNNER_BINARY = 'simforge-runner';

/** Command groups forwarded verbatim to the runner. */
export const RUNNER_GROUPS = ['job', 'worker', 'cas', 'runtime'] as const;
export type RunnerGroup = (typeof RUNNER_GROUPS)[number];

/** `${SIMFORGE_NATIVE_RUNTIME_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime}`. */
export function nativeRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['SIMFORGE_NATIVE_RUNTIME_ROOT'];
  if (explicit) return explicit;
  const dataHome = env['XDG_DATA_HOME'] || path.join(homedir(), '.local', 'share');
  return path.join(dataHome, 'simforge', 'native-runtime');
}

/**
 * Candidate runner paths in discovery order. The bare binary name is last so a
 * `PATH` lookup happens only when no installed runtime declares one.
 */
export function runnerCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const explicit = env['SIMFORGE_RUNNER_BIN'];
  if (explicit) out.push(explicit);
  out.push(path.join(nativeRuntimeRoot(env), 'bin', RUNNER_BINARY));
  out.push(RUNNER_BINARY);
  return out;
}

/** Resolve the runner binary or fail with an installation error. */
export function resolveRunnerBinary(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = runnerCandidates(env);
  for (const candidate of candidates) {
    if (candidate === RUNNER_BINARY) return candidate; // PATH lookup is the spawn's job
    if (existsSync(candidate)) return candidate;
  }
  throw new CliError('runner_not_installed', `${RUNNER_BINARY} was not found`, {
    detail: {
      searched: candidates,
      hint: 'install the SimForge native runtime tarball (scripts/native-runtime/install-runtime.sh) or set SIMFORGE_RUNNER_BIN',
    },
    exitCode: EXIT.commandError,
  });
}

export interface RunnerOptions {
  /** The runner argv after the binary, e.g. `['job', 'submit', 'manifest.json']`. */
  readonly argv: readonly string[];
  readonly pretty: boolean;
  /** `--root <dir>`; forwarded as-is. */
  readonly root?: string | undefined;
}

/**
 * Spawn the runner with inherited stdio and return its exit code. `ENOENT`
 * from a `PATH` lookup is reported as the same installation error as a missing
 * file; signals map to the runner's "cannot run" exit.
 */
export function runRunner(options: RunnerOptions): Promise<number> {
  const binary = resolveRunnerBinary();
  const argv = [
    ...(options.root === undefined ? [] : ['--root', options.root]),
    ...(options.pretty ? ['--pretty'] : []),
    ...options.argv,
  ];
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, argv, { stdio: 'inherit' });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new CliError('runner_not_installed', `${binary} could not be executed`, {
            detail: { searched: runnerCandidates(), hint: 'install the SimForge native runtime tarball or set SIMFORGE_RUNNER_BIN' },
            exitCode: EXIT.commandError,
          }),
        );
        return;
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? EXIT.commandError : EXIT.ok));
    });
  });
}
