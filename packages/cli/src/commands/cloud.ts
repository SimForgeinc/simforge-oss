import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';

const CLOUD_ROOT = '/api/simforge/cloud';
type LocalHostState = { schema: 'simforge.local-host-state/v1'; baseUrl: string; controlToken: string };

async function readHostState(dataRoot?: string): Promise<LocalHostState | null> {
  const root = dataRoot?.trim() || process.env.SIMFORGE_CLOUD_ROOT?.trim() || join(homedir(), '.simforge', 'cloud');
  try {
    const value = JSON.parse(await readFile(join(root, 'host.json'), 'utf8')) as Partial<LocalHostState>;
    if (value.schema !== 'simforge.local-host-state/v1' || typeof value.baseUrl !== 'string' || typeof value.controlToken !== 'string') return null;
    return value as LocalHostState;
  } catch {
    return null;
  }
}

type CloudOptions = { pretty: boolean; dataRoot?: string; origin?: string; workspaceId?: string };

function requireLoopback(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new CliError('bad_value', 'The local Studio host must use an HTTP loopback origin.', { path: '--origin' });
  }
  return url;
}

async function localRequest<T>(path: string, options: CloudOptions, init: RequestInit = {}): Promise<T> {
  const state = await readHostState(options.dataRoot);
  if (!state) {
    throw new CliError('host_unavailable', 'No running local Studio host was found. Start SimForge Studio first.', {
      detail: { dataRoot: options.dataRoot ?? null },
    });
  }
  const base = requireLoopback(state.baseUrl);
  const response = await fetch(new URL(`${CLOUD_ROOT}${path}`, base), {
    ...init,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${state.controlToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `request_failed_${response.status}`;
    throw new CliError(code, body && typeof body.message === 'string' ? body.message : `Cloud request failed (${response.status}).`, {
      detail: body,
    });
  }
  return body as T;
}

export async function cloudCommand(operation: string | undefined, options: CloudOptions): Promise<number> {
  let result: unknown;
  switch (operation) {
    case 'status':
      result = await localRequest('/status', options);
      break;
    case 'connect': {
      result = await localRequest('/connect', options, {
        method: 'POST',
        body: JSON.stringify(options.origin ? { origin: options.origin } : {}),
      });
      break;
    }
    case 'disconnect':
      result = await localRequest('/disconnect', options, { method: 'POST' });
      break;
    case 'workspaces':
      result = await localRequest('/workspaces', options);
      break;
    case 'datasets': {
      if (!options.workspaceId) throw new CliError('missing_argument', 'cloud datasets requires --workspace <id>', { path: '--workspace' });
      result = await localRequest(`/datasets?workspaceId=${encodeURIComponent(options.workspaceId)}`, options);
      break;
    }
    case 'artifacts': {
      if (!options.workspaceId) throw new CliError('missing_argument', 'cloud artifacts requires --workspace <id>', { path: '--workspace' });
      result = await localRequest(`/artifacts?workspaceId=${encodeURIComponent(options.workspaceId)}`, options);
      break;
    }
    default:
      throw new CliError('unknown_command', `unknown cloud operation ${operation ?? '(missing)'}`, {
        detail: { known: ['status', 'connect', 'disconnect', 'workspaces', 'datasets', 'artifacts'] },
      });
  }
  emit(result, { pretty: options.pretty });
  return EXIT.ok;
}
