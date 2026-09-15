import { URL } from 'node:url';
import { checkHostProtocolVersion } from '@simforge-oss/studio-host';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { CliError } from './errors.js';

export type HostRequestOptions = { dataRoot?: string; headers?: HeadersInit };

const CAPABILITIES_PATH = '/api/simforge/host/capabilities';

function loopback(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new CliError('bad_value', 'The local Studio host must use an HTTP loopback origin.', { path: '--origin' });
  }
  return url;
}

function authorized(controlToken: string, init: RequestInit, extra?: HeadersInit): RequestInit {
  return {
    ...init,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(extra as Record<string, string> | undefined),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

/**
 * The host protocol handshake, once per host per CLI process. A host whose
 * capability document reports another protocol version (or none) is refused
 * before the CLI issues the call it was asked for; the refusal names both
 * versions and which side to upgrade. A probe that fails for transport
 * reasons is not cached, so the next command re-asks rather than remembering
 * a transient failure as an incompatible host.
 */
const verifiedHosts = new Map<string, Promise<void>>();

function verifyHostProtocol(base: URL, controlToken: string): Promise<void> {
  const key = base.origin;
  let pending = verifiedHosts.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(new URL(CAPABILITIES_PATH, base), authorized(controlToken, {}));
      if (!response.ok) {
        throw new CliError('host_unavailable', `The Studio host at ${key} answered ${response.status} to the capabilities probe.`);
      }
      const protocol = checkHostProtocolVersion(await response.json().catch(() => null));
      if (!protocol.ok) {
        throw new CliError('host_incompatible', `The Studio host at ${key} is incompatible with this CLI: ${protocol.reason}.`, {
          detail: { olderSide: protocol.olderSide },
        });
      }
    })();
    verifiedHosts.set(key, pending);
    pending.catch((error: unknown) => {
      if (!(error instanceof CliError && error.code === 'host_incompatible')) verifiedHosts.delete(key);
    });
  }
  return pending;
}

export async function hostFetch(path: string, options: HostRequestOptions = {}, init: RequestInit = {}): Promise<Response> {
  const state = await readLocalHostState(options.dataRoot ? { SIMFORGE_CLOUD_ROOT: options.dataRoot } : process.env);
  if (!state) throw new CliError('host_unavailable', 'No running local Studio host was found. Start SimForge Studio first.');
  const base = loopback(state.baseUrl);
  await verifyHostProtocol(base, state.controlToken);
  return fetch(new URL(path, base), authorized(state.controlToken, init, options.headers));
}

export async function hostRequest<T>(path: string, options: HostRequestOptions = {}, init: RequestInit = {}): Promise<T> {
  const response = await hostFetch(path, options, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `request_failed_${response.status}`;
    throw new CliError(code, body && typeof body.message === 'string' ? body.message : `Host request failed (${response.status}).`);
  }
  return body as T;
}
