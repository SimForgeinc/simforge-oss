import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runLocalHost, type LocalHostPlan } from '@simforge-oss/studio-host/node';
import { CliError } from '../errors.js';

/**
 * `simforge daemon`: the local Studio host in the foreground.
 *
 * This is the one supervisor every other surface builds on: `simforge daemon`
 * runs it in the foreground, `pnpm dev` in the studio runs it with `--dev`,
 * Electron shell spawns it (a packaged application runs the staged
 * equivalent, `studio/desktop/host.ts`, over the same supervisor). The
 * workspace plan serves Studio from the installed workspace and starts the
 * same `simforge worker` CLI used for remote nodes; both children use the
 * current interpreter.
 */
export type DaemonOptions = {
  readonly port?: number;
  readonly dataRoot?: string;
  /** `next dev` on live sources instead of `next start` on the built output. */
  readonly dev?: boolean;
  readonly noWorker?: boolean;
  readonly cloudOrigin?: string;
  /**
   * Address the server binds. Defaults to loopback: a daemon is private until
   * an operator says otherwise. `0.0.0.0` exposes the host's gate on every
   * interface, which is authorized by the control token rather than by the
   * caller's address, so the link itself must be private (a tailnet or a TLS
   * terminator) - see docs/engineering/remote-studio-host.md.
   */
  readonly hostname?: string;
};

const require = createRequire(import.meta.url);
const cliRoot = resolve(dirname(require.resolve('@simforge-oss/cli')), '..');
const studioRoot = dirname(require.resolve('@simforge-oss/studio/package.json'));

function runStudioScript(tsxCli: string, script: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: studioRoot,
      stdio: 'inherit',
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (code === 0) done();
      else fail(new CliError('studio_bootstrap_failed', `${script} exited with ${signal ?? code}`, { detail: { script, code, signal } }));
    });
  });
}

/**
 * Wildcard binds are addresses to listen on, not addresses to call:
 * `http://0.0.0.0:<port>` names no destination, so a worker given one cannot
 * reach the server it belongs to. Every other bind is a real address and is
 * also the *only* one the server answers on - binding `100.64.0.1` does not
 * serve loopback - so the worker must use the bound address itself rather
 * than assume its own machine is reachable at `127.0.0.1`.
 */
const WILDCARD_BINDS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]', '*']);

export function workerBaseUrl(hostname: string, port: number): string {
  return WILDCARD_BINDS.has(hostname) ? `http://127.0.0.1:${port}` : `http://${hostname}:${port}`;
}

function workspacePlan(dev: boolean, port: number, hostname: string): LocalHostPlan {
  const nextBin = require.resolve('next/dist/bin/next', { paths: [studioRoot] });
  const tsxCli = require.resolve('tsx/cli', { paths: [studioRoot] });
  const workerHost = workerBaseUrl(hostname, port);
  return {
    // Seed runs migrations in its own process so the CLI never loads the Next
    // application's modules. It closes PGlite before the server takes ownership.
    bootstrap: async () => {
      await runStudioScript(tsxCli, resolve(studioRoot, 'scripts', 'seed.ts'));
    },
    server: {
      command: process.execPath,
      // `-H` in both modes: a daemon told to bind an address binds it whether
      // or not it is serving a build, and `next dev` without it serves
      // loopback only however the daemon was invoked.
      args: dev
        ? [nextBin, 'dev', '--webpack', '-p', String(port), '-H', hostname]
        : [nextBin, 'start', '-p', String(port), '-H', hostname],
      cwd: studioRoot,
    },
    // `bin/simforge.js` imports the built `dist/main.js`, which a source
    // checkout does not have: in dev the worker runs through tsx on the same
    // sources the server is serving, exactly like `next dev` above.
    worker: {
      command: process.execPath,
      args: [
        ...(dev ? [tsxCli, resolve(cliRoot, 'src', 'main.ts')] : [resolve(cliRoot, 'bin', 'simforge.js')]),
        'worker',
        '--host',
        workerHost,
        '--token',
        '${SIMFORGE_RENDER_WORKER_TOKEN}',
      ],
      cwd: studioRoot,
    },
  };
}

export async function daemonCommand(options: DaemonOptions = {}): Promise<number> {
  if (options.dataRoot) process.env.SIMFORGE_CLOUD_ROOT = resolve(options.dataRoot);
  if (options.cloudOrigin) process.env.SIMFORGE_CLOUD_ORIGIN = options.cloudOrigin;
  const dev = options.dev === true;
  if (!dev && !existsSync(resolve(studioRoot, '.next'))) {
    throw new CliError('studio_build_missing', `No Studio build at ${resolve(studioRoot, '.next')}; run \`pnpm --filter @simforge-oss/studio build\` or pass --dev.`, {
      path: '--dev',
    });
  }
  const port = options.port ?? Number(process.env.PORT ?? '5199');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CliError('bad_value', `Invalid port ${String(options.port ?? process.env.PORT)}.`, { path: '--port' });
  }
  // `HOSTNAME` is what `localHostConfig()` reads and what
  // docs/engineering/remote-studio-host.md tells an operator to set, so the
  // CLI honours it rather than pinning loopback and silently ignoring it.
  const hostname = (options.hostname ?? process.env.HOSTNAME ?? '127.0.0.1').trim();
  if (hostname === '') {
    throw new CliError('bad_value', 'Empty --hostname; pass an address to bind, or omit it for loopback.', { path: '--hostname' });
  }
  return runLocalHost(workspacePlan(dev, port, hostname), {
    port,
    hostname,
    withWorker: options.noWorker !== true && process.env.SIMFORGE_LOCAL_WORKER !== '0',
  });
}
