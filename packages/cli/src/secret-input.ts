/**
 * Password input for the headless account verbs.
 *
 * A password must never be an argv flag: `/proc/<pid>/cmdline` and `ps` expose
 * argv to every user on the machine, and shell history keeps it afterwards.
 * So there are exactly three sources, tried in this order:
 *
 * 1. `SIMFORGE_CLOUD_PASSWORD` — for CI and unattended agents.
 * 2. `--password-stdin` — one line on stdin (`… | simforge cloud sign-in …`).
 * 3. an interactive prompt with echo disabled, when stdin is a TTY.
 *
 * With none of the three available the command refuses instead of hanging on a
 * stdin that will never carry a line. The value is returned to the caller,
 * posted to the local host, and never logged, echoed or written anywhere.
 */

import { CliError } from './errors.js';

export const PASSWORD_ENV = 'SIMFORGE_CLOUD_PASSWORD';

/** `--password <value>` is refused loudly rather than quietly accepted. */
export function rejectPasswordArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new CliError(
        'password_in_argv',
        `A password cannot be passed on the command line: argv is visible to every process on this machine. Use ${PASSWORD_ENV}, --password-stdin, or run the command on a terminal and type it at the prompt.`,
        { path: '--password' },
      );
    }
  }
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n');
  const line = end >= 0 ? text.slice(0, end) : text;
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Raw-mode read so the characters are never rendered, not even to the TTY. */
function promptNoEcho(label: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const settle = (error?: CliError) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return settle();
        if (char === '\u0003') return settle(new CliError('interrupted', 'Password entry was cancelled.'));
        if (char === '\u0004') return value.length === 0
          ? settle(new CliError('interrupted', 'Password entry was cancelled.'))
          : settle();
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export interface SecretOptions {
  /** Named in the prompt and in the refusal, e.g. `cloud sign-in`. */
  readonly operation: string;
  /** What is being asked for: `password`, `new password`. */
  readonly label: string;
  /** Whether `--password-stdin` was given. */
  readonly stdin: boolean;
}

export async function readPassword(options: SecretOptions): Promise<string> {
  const source = await passwordSource(options);
  if (source.value.length === 0) {
    throw new CliError('empty_password', `The ${options.label} read from ${source.from} is empty.`);
  }
  return source.value;
}

async function passwordSource(options: SecretOptions): Promise<{ value: string; from: string }> {
  const fromEnv = process.env[PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, from: PASSWORD_ENV };
  if (options.stdin) return { value: await readStdinLine(), from: 'stdin' };
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    return { value: await promptNoEcho(`${options.label[0]?.toUpperCase()}${options.label.slice(1)} for ${options.operation}: `), from: 'the prompt' };
  }
  throw new CliError(
    'password_required',
    `cloud ${options.operation} needs a ${options.label} and there is no terminal to ask on. Set ${PASSWORD_ENV}, or pipe it in with --password-stdin.`,
  );
}
