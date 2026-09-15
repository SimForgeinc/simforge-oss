import { spawn } from 'node:child_process';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { boolFlag, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { hostRequest } from '../host-client.js';
import { emit } from '../output.js';
import { hostSession, requireSubcommand } from './local.js';

export const HOST_COMMANDS = ['status', 'stop', 'open'] as const;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `host status` never throws for a stopped host: a stopped host is a status,
 * not an error. `host stop` asks the running host to shut down through its own
 * control route so the database closes cleanly. `host open` mints a one-use
 * browser ticket; the control token itself is only ever sent in a header.
 */
export async function hostCommand(argv: readonly string[]): Promise<number> {
  const sub = requireSubcommand('host', argv[0], HOST_COMMANDS);
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: ['data-root', ...(sub === 'open' ? ['next'] : [])] });
  if (args.positionals.length) throw new CliError('bad_value', 'host commands take no positional arguments');
  const dataRoot = optionalString(args, 'data-root');
  const pretty = boolFlag(args, 'pretty');
  const state = await readLocalHostState(dataRoot ? { SIMFORGE_CLOUD_ROOT: dataRoot } : process.env);
  const running = state !== null && alive(state.pid);

  switch (sub) {
    case 'status': {
      if (!running) {
        emit({ running: false, ...(state ? { reason: 'host_process_gone', pid: state.pid, baseUrl: state.baseUrl } : { reason: 'host_state_missing' }) }, { pretty });
        return EXIT.ok;
      }
      const session = await hostSession(dataRoot);
      const capabilities = await session.host.runtime.capabilities({ fresh: true })
        .catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
      const workers = 'execution' in capabilities && Array.isArray(capabilities.execution.workerNodes) ? capabilities.execution.workerNodes : [];
      emit({ running: true, pid: state.pid, baseUrl: state.baseUrl, workers, capabilities }, { pretty });
      return EXIT.ok;
    }
    case 'stop': {
      if (!running) {
        emit({ stopped: false, reason: 'not_running' }, { pretty });
        return EXIT.ok;
      }
      const result = await hostRequest<{ ok: true; pid: number }>('/api/simforge/host/shutdown', { dataRoot }, { method: 'POST' });
      const deadline = Date.now() + 15_000;
      while (alive(result.pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      emit({ stopped: !alive(result.pid), pid: result.pid }, { pretty });
      return EXIT.ok;
    }
    case 'open': {
      if (!running) throw new CliError('host_unavailable', 'No running local Studio host was found. Start it with `simforge daemon`.');
      const body = await hostRequest<{ url: string }>('/api/simforge/host/session', { dataRoot }, {
        method: 'POST',
        body: JSON.stringify({ next: optionalString(args, 'next') ?? '/dashboard/scenario' }),
      });
      const target = new URL(body.url);
      // The host may spell loopback differently from its own record (localhost vs 127.0.0.1); the port is the identity.
      const loopback = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
      if (!loopback || target.port !== new URL(state.baseUrl).port) {
        throw new CliError('host_unavailable', 'Host returned a foreign browser bootstrap URL.', { detail: { url: target.origin } });
      }
      const opener = process.platform === 'darwin'
        ? { command: 'open', args: [target.href] }
        : process.platform === 'win32'
          ? { command: 'cmd', args: ['/c', 'start', '', target.href.replace(/&/g, '^&')] }
          : { command: 'xdg-open', args: [target.href] };
      const child = spawn(opener.command, opener.args, { stdio: 'ignore', detached: true });
      const opened = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(false));
        child.once('spawn', () => { child.unref(); resolve(true); });
      });
      emit({ opened, baseUrl: state.baseUrl, ...(opened ? {} : { url: target.href }) }, { pretty });
      return EXIT.ok;
    }
  }
}
