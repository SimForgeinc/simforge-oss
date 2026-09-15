import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { CliError } from '../errors.js';
import { listFlag, optionalString, parseArgs, requireString } from '../args.js';

export const WORKER_CAPABILITIES = [
  'native-render',
  'browser-render',
  'carla-render',
  'compile',
  'model-run',
] as const;
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

export type WorkerOptions = {
  readonly host: string;
  readonly token: string;
  readonly id?: string;
  readonly capabilities?: readonly WorkerCapability[];
  readonly dataRoot?: string;
};

const require = createRequire(import.meta.url);
const studioRoot = dirname(require.resolve('@simforge-oss/studio/package.json'));

function hostOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError('bad_value', `--host must be an http(s) origin, got "${value}".`, { path: '--host' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('bad_value', `--host must be an http(s) origin, got "${value}".`, { path: '--host' });
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new CliError('bad_value', `--host must be an http(s) origin, got "${value}".`, { path: '--host' });
  }
  return parsed.origin;
}

function capabilities(value: readonly string[] | undefined): WorkerCapability[] | undefined {
  if (value === undefined) return undefined;
  const parsed: WorkerCapability[] = [];
  for (const item of value) {
    if (!(WORKER_CAPABILITIES as readonly string[]).includes(item)) {
      throw new CliError('bad_value', `Unknown worker capability "${item}".`, {
        path: '--capabilities',
        detail: { known: WORKER_CAPABILITIES },
      });
    }
    const capability = item as WorkerCapability;
    if (!parsed.includes(capability)) parsed.push(capability);
  }
  if (parsed.length === 0) throw new CliError('bad_value', '--capabilities must contain at least one capability.', { path: '--capabilities' });
  return parsed;
}

export async function workerCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['pretty'], values: ['host', 'token', 'id', 'capabilities', 'data-root'] });
  if (args.positionals.length > 0) throw new CliError('bad_value', 'worker takes no positional arguments.');
  const rawToken = requireString(args, 'token');
  const token = rawToken.trim();
  if (!token) throw new CliError('missing_option', '--token is required', { path: '--token' });
  const options: WorkerOptions = {
    host: hostOrigin(requireString(args, 'host')),
    token,
    id: optionalString(args, 'id')?.trim() || undefined,
    capabilities: capabilities(listFlag(args, 'capabilities')),
    dataRoot: optionalString(args, 'data-root'),
  };
  const tsxCli = require.resolve('tsx/cli', { paths: [studioRoot] });
  const workerEntry = resolve(studioRoot, 'worker', 'index.ts');
  const child = spawn(process.execPath, [tsxCli, workerEntry], {
    cwd: studioRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SIMFORGE_API_BASE_URL: options.host,
      SIMFORGE_RENDER_WORKER_TOKEN: options.token,
      ...(options.id ? { SIMFORGE_RENDER_WORKER_ID: options.id, SIMFORGE_COMPILER_WORKER_ID: options.id } : {}),
      ...(options.capabilities ? { SIMFORGE_WORKER_CAPABILITIES: options.capabilities.join(',') } : {}),
      ...(options.dataRoot ? { SIMFORGE_LOCAL_WORKER_ROOT: resolve(options.dataRoot) } : {}),
    },
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  try {
    return await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } catch (error) {
    throw new CliError('worker_start_failed', error instanceof Error ? error.message : String(error));
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}
