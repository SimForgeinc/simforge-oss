import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HostOrigin, StudioHostRequestError, createHttpStudioHost, type StudioHostServices } from '@simforge-oss/studio-host';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { CliError } from '../errors.js';

/** Which of the two ways of naming a host answered for this invocation. */
export type HostSessionSource = 'SIMFORGE_API_BASE_URL' | 'local-host-state';

export type HostSession = {
  host: StudioHostServices;
  baseUrl: string;
  headers: Record<string, string>;
  source: HostSessionSource;
};

/**
 * Where the public `/api/simforge/*` routes live for this invocation, when the
 * environment names them.
 *
 * `SIMFORGE_API_BASE_URL` is the one thing that differs between driving the dev
 * host on this machine and driving a remote SimCloud host: the command, its
 * flags and the wire contract are identical either way. `SIMFORGE_REMOTE_HOST`
 * is accepted as the same thing under the name the desktop shell already uses
 * (`studio/desktop/remote-host.mjs`), together with its token and plaintext
 * acknowledgement variables, so there is one spelling of "a host elsewhere"
 * rather than two.
 *
 * Returns null when neither is set, which is what keeps the running local
 * daemon the default.
 */
export function configuredHostTarget(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; token: string | null } | null {
  const configured = env.SIMFORGE_API_BASE_URL?.trim() || env.SIMFORGE_REMOTE_HOST?.trim();
  if (!configured) return null;
  const variable = env.SIMFORGE_API_BASE_URL?.trim() ? 'SIMFORGE_API_BASE_URL' : 'SIMFORGE_REMOTE_HOST';
  try {
    const origin = HostOrigin.fromConfigured(configured, 'packaged', {
      plaintextNetworkAcknowledged: env.SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT === '1',
    });
    return { baseUrl: origin.hrefForCookie(), token: env.SIMFORGE_REMOTE_HOST_TOKEN?.trim() || null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'bad_value';
    throw new CliError(code, error instanceof Error ? error.message : String(error), { path: variable });
  }
}

/**
 * The host this invocation talks to, as a typed client; the CLI never opens the
 * database itself.
 *
 * An explicit `--data-root` names a local data root, so it always resolves the
 * local daemon's `host.json` — a flag that says "this folder on this machine"
 * is not overridden by an environment variable.
 */
export async function hostSession(dataRoot?: string, env: NodeJS.ProcessEnv = process.env): Promise<HostSession> {
  const configured = dataRoot ? null : configuredHostTarget(env);
  if (configured) {
    const headers: Record<string, string> = configured.token ? { authorization: `Bearer ${configured.token}` } : {};
    return {
      host: createHttpStudioHost({ baseUrl: configured.baseUrl, headers }),
      baseUrl: configured.baseUrl,
      headers,
      source: 'SIMFORGE_API_BASE_URL',
    };
  }
  // `--data-root` overrides only the data root; `localHostStateDir` reads no other key,
  // so overriding it on a copy of `env` is exactly equivalent to passing a bare env —
  // and stays assignable to `ProcessEnv` when Studio's program augments it (`NODE_ENV`).
  const state = await readLocalHostState(dataRoot ? { ...env, SIMFORGE_CLOUD_ROOT: dataRoot } : env);
  if (!state) {
    throw new CliError('host_unavailable', 'No running local Studio host was found. Start it with `simforge daemon`, or point SIMFORGE_API_BASE_URL at a host.', { detail: { dataRoot: dataRoot ?? null } });
  }
  const headers = { authorization: `Bearer ${state.controlToken}` };
  return { host: createHttpStudioHost({ baseUrl: state.baseUrl, headers }), baseUrl: state.baseUrl, headers, source: 'local-host-state' };
}

/**
 * One host call, with the route's own refusal kept intact.
 *
 * `StudioHostRequestError` carries the error body's `error` code and `message`
 * (`http-client.ts:157-170`); rethrowing it as a `CliError` with that code is
 * what puts the host's answer on stderr instead of `internal_error:
 * StudioHostRequestError`.
 */
export async function hostCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StudioHostRequestError) {
      throw new CliError(error.code, error.message, { detail: { status: error.status, operation } });
    }
    throw error;
  }
}

/** Re-read `probe` until `done` accepts the value or `timeoutSeconds` elapses. */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  options: { timeoutSeconds: number; intervalMs: number; onTimeout: (last: T) => CliError },
): Promise<T> {
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw options.onTimeout(value);
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

/** Stream one URL into `dir/name`; the caller decides the name. */
export async function downloadTo(url: string | URL, dir: string, name: string, init: RequestInit = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const response = await fetch(url, { redirect: 'error', ...init });
  if (!response.ok || !response.body) {
    throw new CliError('artifact_download_failed', `Download of ${name} failed (${response.status}).`);
  }
  const path = join(dir, name);
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(path));
  return path;
}

export function extensionFor(mediaType: string): string {
  if (mediaType.includes('json')) return 'json';
  if (mediaType.includes('mp4')) return 'mp4';
  if (mediaType.includes('webm')) return 'webm';
  if (mediaType.includes('zip')) return 'zip';
  if (mediaType.includes('png')) return 'png';
  return 'bin';
}

/** Reject any subcommand outside `known`, with the list in the error so agents can self-correct. */
export function requireSubcommand<const K extends readonly string[]>(group: string, sub: string | undefined, known: K): K[number] {
  if (sub === undefined || !known.includes(sub)) {
    throw new CliError('unknown_command', `Unknown ${group} command: ${sub ?? '(none)'}`, { detail: { known } });
  }
  return sub;
}
