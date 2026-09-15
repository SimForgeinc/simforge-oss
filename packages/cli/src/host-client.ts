import { URL } from 'node:url';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { CliError } from './errors.js';

export type HostRequestOptions = { dataRoot?: string; headers?: HeadersInit };

function loopback(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new CliError('bad_value', 'The local Studio host must use an HTTP loopback origin.', { path: '--origin' });
  }
  return url;
}

export async function hostFetch(path: string, options: HostRequestOptions = {}, init: RequestInit = {}): Promise<Response> {
  const state = await readLocalHostState(options.dataRoot ? { SIMFORGE_CLOUD_ROOT: options.dataRoot } : process.env);
  if (!state) throw new CliError('host_unavailable', 'No running local Studio host was found. Start SimForge Studio first.', { detail: { dataRoot: options.dataRoot ?? null } });
  const base = loopback(state.baseUrl);
  return fetch(new URL(path, base), {
    ...init,
    redirect: 'error',
    headers: { authorization: `Bearer ${state.controlToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(options.headers as Record<string, string> | undefined), ...(init.headers as Record<string, string> | undefined) },
  });
}

export async function hostRequest<T>(path: string, options: HostRequestOptions = {}, init: RequestInit = {}): Promise<T> {
  const response = await hostFetch(path, options, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `request_failed_${response.status}`;
    throw new CliError(code, body && typeof body.message === 'string' ? body.message : `Host request failed (${response.status}).`, { detail: body });
  }
  return body as T;
}
