import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHttpStudioHost, type StudioHostServices } from '@simforge-oss/studio-host';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { CliError } from '../errors.js';

export type HostSession = { host: StudioHostServices; baseUrl: string; headers: Record<string, string> };

/** The running local host as a typed client; the CLI never opens the database itself. */
export async function hostSession(dataRoot?: string): Promise<HostSession> {
  const state = await readLocalHostState(dataRoot ? { SIMFORGE_CLOUD_ROOT: dataRoot } : process.env);
  if (!state) {
    throw new CliError('host_unavailable', 'No running local Studio host was found. Start it with `simforge daemon`.', { detail: { dataRoot: dataRoot ?? null } });
  }
  const headers = { authorization: `Bearer ${state.controlToken}` };
  return { host: createHttpStudioHost({ baseUrl: state.baseUrl, headers }), baseUrl: state.baseUrl, headers };
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
