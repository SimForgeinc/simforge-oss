import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readLocalHostState } from '@simforge-oss/studio-host/node';
import { boolFlag, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { hostRequest } from '../host-client.js';
import { emit, emitLines } from '../output.js';
import { hostSession, requireSubcommand } from './local.js';

export const HOST_COMMANDS = ['status', 'stop', 'open', 'pair'] as const;

const UNROUTABLE_BINDS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0', '[::]', '::']);

/**
 * The origin a `simforge://connect` link advertises to the other machine.
 * The host record names the bound address, which is the reachable origin for
 * a single-interface bind and useless for a loopback or wildcard bind: a
 * remote shell cannot dial `0.0.0.0`, and `127.0.0.1` is its own machine.
 * Those need `--origin`; nothing is guessed.
 */
export function advertisedPairingOrigin(baseUrl: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new CliError('bad_value', `--origin must be the host's base URL as the other machine reaches it, for example http://100.72.252.40:5421.`, { path: '--origin' });
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new CliError('bad_value', `--origin must be a bare http:// or https:// origin.`, { path: '--origin' });
    }
    return url.origin;
  }
  const bound = new URL(baseUrl);
  if (UNROUTABLE_BINDS.has(bound.hostname)) {
    throw new CliError('bad_value', `The host is bound to ${bound.hostname}, which another machine cannot dial. Pass --origin <url> with the address the shell will use, for example the tailnet address.`, { path: '--origin' });
  }
  return bound.origin;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is anything still accepting connections on the host's port? A supervisor
 * killed without running its shutdown path used to leave the Next server
 * behind, so "the supervisor pid is gone" is not the same as "the host is
 * stopped": the orphan kept the port and the data-root lock. Loopback is the
 * right probe for a local CLI - a server bound to every interface accepts
 * there too.
 */
function portBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (bound: boolean) => {
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * `host status` never throws for a stopped host: a stopped host is a status,
 * not an error. `host stop` asks the running host to shut down through its own
 * control route so the database closes cleanly. `host open` mints a one-use
 * browser ticket; the control token itself is only ever sent in a header.
 * `host pair` mints a one-use pairing code for a desktop shell on another
 * machine, so nobody copies the token by hand: the shell exchanges the code
 * once (POST /api/simforge/host/pair, token in the response body) and keeps
 * the token in its own OS vault.
 */
export async function hostCommand(argv: readonly string[]): Promise<number> {
  const sub = requireSubcommand('host', argv[0], HOST_COMMANDS);
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: ['data-root', ...(sub === 'open' ? ['next'] : sub === 'pair' ? ['origin'] : [])] });
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
        // The supervisor is gone; an orphaned server may still hold its port.
        if (state && await portBound(state.port)) {
          emit({ stopped: false, reason: 'orphaned_server', pid: state.pid, port: state.port, baseUrl: state.baseUrl }, { pretty });
          return EXIT.ok;
        }
        emit({ stopped: false, reason: 'not_running' }, { pretty });
        return EXIT.ok;
      }
      const result = await hostRequest<{ ok: true; pid: number }>('/api/simforge/host/shutdown', { dataRoot }, { method: 'POST' });
      const deadline = Date.now() + 15_000;
      while (alive(result.pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      // `stopped` means the whole group is down, not just the supervisor.
      const bound = await portBound(state.port);
      emit({
        stopped: !alive(result.pid) && !bound,
        pid: result.pid,
        ...(bound ? { reason: 'port_still_bound', port: state.port } : {}),
      }, { pretty });
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
    case 'pair': {
      if (!running) throw new CliError('host_unavailable', 'No running local Studio host was found. Start it with `simforge daemon`.');
      const origin = advertisedPairingOrigin(state.baseUrl, optionalString(args, 'origin'));
      // The host's own record, on the host's own filesystem, mode 0600: the
      // bound address is dialled as written. A single-interface bind does not
      // serve loopback, so the loopback-only client is the wrong tool here.
      const response = await fetch(`${state.baseUrl}/api/simforge/host/pair`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${state.controlToken}`, 'content-type': 'application/json' },
        body: '{}',
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' || !('expiresAt' in body)) {
        const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `request_failed_${response.status}`;
        throw new CliError(code, `The host did not mint a pairing code (${response.status}).`);
      }
      const link = `simforge://connect?${new URLSearchParams({ origin, code: body.code })}`;
      if (pretty) {
        emitLines([
          `Pairing code: ${body.code}   (expires ${String(body.expiresAt)}, one use)`,
          `Host origin:  ${origin}`,
          '',
          'In SimForge Studio on the other machine: Connection > Switch Connection... > Pair with a host on another machine, then paste',
          `  ${link}`,
        ]);
      } else {
        emit({ code: body.code, expiresAt: body.expiresAt, origin, connect: link }, { pretty });
      }
      return EXIT.ok;
    }
  }
}
