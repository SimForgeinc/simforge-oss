import { boolFlag, optionalString, parseArgs, type ParsedArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { hostRequest } from '../host-client.js';
import { emit } from '../output.js';
import { readPassword, rejectPasswordArgv } from '../secret-input.js';
import { requireSubcommand } from './local.js';

const CLOUD_ROOT = '/api/simforge/cloud';

export const CLOUD_COMMANDS = [
  'status', 'connect', 'sign-in', 'sign-up', 'verify-email', 'resend-code',
  'forgot-password', 'reset-password', 'sign-out', 'organizations', 'datasets',
  'artifacts', 'dataset-import', 'dataset-publish', 'artifact-import',
  'artifact-upload', 'dataset-links', 'artifact-links',
] as const;

const PROVIDERS = ['google', 'github'] as const;

/** Every verb reads the same two flags; the rest are named per subcommand below. */
const COMMON = ['data-root'];

/**
 * Signing in never selects a tenant (`status.activeOrganizationId` is null
 * after a password grant), so a missing `--org` is the one omission that would
 * otherwise reach the platform and come back as a bare tenant code. Say what
 * to pass instead.
 */
const HINTS: Record<string, string> = {
  org: 'signing in does not select one; `simforge cloud organizations` lists the ids you are a member of',
};

function requireValue(args: ParsedArgs, name: string, operation: string): string {
  const value = optionalString(args, name);
  if (!value) {
    const hint = HINTS[name];
    throw new CliError('missing_argument', `cloud ${operation} requires --${name}${hint ? ` (${hint})` : ''}`, { path: `--${name}` });
  }
  return value;
}

/**
 * Authenticated SimCloud operations through the running local host. The host
 * owns the credentials; the CLI never sees a token. The host origin always
 * comes from host.json - there is nothing to override.
 *
 * The account verbs (`sign-in` … `sign-out`) make the whole email+password
 * flow reachable without a browser or the desktop app. They post the secret
 * to the host and print the host's connection status; the password itself
 * comes from the environment, stdin or a no-echo prompt, never from argv
 * (see `secret-input.ts`).
 */
export async function cloudCommand(argv: readonly string[]): Promise<number> {
  const sub = requireSubcommand('cloud', argv[0], CLOUD_COMMANDS);
  rejectPasswordArgv(argv);
  const values = {
    connect: ['provider', 'cloud-origin'],
    'sign-in': ['email'],
    'sign-up': ['email', 'name'],
    'verify-email': ['code'],
    'forgot-password': ['email'],
    'reset-password': ['email', 'code'],
    datasets: ['org'],
    artifacts: ['org'],
    'dataset-import': ['org', 'dataset'],
    'dataset-publish': ['org', 'dataset', 'remote-dataset'],
    'artifact-import': ['org', 'artifact'],
    'artifact-upload': ['org', 'artifact'],
  }[sub as string] ?? [];
  const args = parseArgs(argv.slice(1), { booleans: ['pretty', 'password-stdin'], values: [...COMMON, ...values] });
  const request = <T>(path: string, init: RequestInit = {}) => hostRequest<T>(`${CLOUD_ROOT}${path}`, { dataRoot: optionalString(args, 'data-root') }, init);
  const post = (path: string, body?: Record<string, unknown>) => request(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
  const organizationQuery = () => `?organizationId=${encodeURIComponent(requireValue(args, 'org', sub))}`;
  const password = (label: string) => readPassword({ operation: sub, label, stdin: boolFlag(args, 'password-stdin') });

  let result: unknown;
  switch (sub) {
    case 'status': result = await request('/status'); break;
    case 'connect': {
      const provider = requireValue(args, 'provider', sub);
      if (!(PROVIDERS as readonly string[]).includes(provider)) throw new CliError('bad_value', `--provider must be ${PROVIDERS.join(' or ')}`, { path: '--provider' });
      const origin = optionalString(args, 'cloud-origin');
      result = await post('/connect', { provider, ...(origin ? { origin } : {}) });
      break;
    }
    case 'sign-in':
      result = await post('/auth/sign-in', { email: requireValue(args, 'email', sub), password: await password('password') });
      break;
    case 'sign-up':
      result = await post('/auth/sign-up', {
        email: requireValue(args, 'email', sub),
        name: requireValue(args, 'name', sub),
        password: await password('password'),
      });
      break;
    case 'verify-email': result = await post('/auth/verify-email', { code: requireValue(args, 'code', sub) }); break;
    case 'resend-code': result = await post('/auth/verify-email/resend'); break;
    case 'forgot-password': result = await post('/auth/password/forgot', { email: requireValue(args, 'email', sub) }); break;
    case 'reset-password':
      result = await post('/auth/password/reset', {
        email: requireValue(args, 'email', sub),
        code: requireValue(args, 'code', sub),
        newPassword: await password('new password'),
      });
      break;
    case 'sign-out': result = await post('/disconnect'); break;
    case 'organizations': result = await request('/organizations'); break;
    case 'datasets': result = await request(`/datasets${organizationQuery()}`); break;
    case 'artifacts': result = await request(`/artifacts${organizationQuery()}`); break;
    case 'dataset-import':
      result = await post('/datasets/import', { organizationId: requireValue(args, 'org', sub), datasetId: requireValue(args, 'dataset', sub) });
      break;
    case 'dataset-publish': {
      const remoteDatasetId = optionalString(args, 'remote-dataset');
      result = await post('/datasets/publish', {
        organizationId: requireValue(args, 'org', sub),
        datasetId: requireValue(args, 'dataset', sub),
        ...(remoteDatasetId ? { remoteDatasetId } : {}),
      });
      break;
    }
    case 'artifact-import':
      result = await post('/artifacts/import', { organizationId: requireValue(args, 'org', sub), artifactId: requireValue(args, 'artifact', sub) });
      break;
    case 'artifact-upload':
      result = await post('/artifacts/upload', { organizationId: requireValue(args, 'org', sub), artifactId: requireValue(args, 'artifact', sub) });
      break;
    case 'dataset-links': result = await request('/datasets/links'); break;
    case 'artifact-links': result = await request('/artifacts/links'); break;
  }
  emit(result, { pretty: boolFlag(args, 'pretty') });
  return EXIT.ok;
}
