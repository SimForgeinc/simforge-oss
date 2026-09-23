import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { repositoryRoot, stopProcess } from './model-socket.js';

export interface AppearanceSpec {
  readonly model: string;
  readonly identity: string;
}

export interface AppearanceSession {
  readonly child: ChildProcess;
  readonly socket: string;
  readonly identity: string;
}

// Same ES2022 declaration bridge as the bench model-socket helper.
const promises = Promise as PromiseConstructor & { withResolvers<T>(): {
  promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void;
} };

export async function appearanceSpec(value: string): Promise<AppearanceSpec> {
  if (!value.startsWith('regen:') || value.length <= 6) throw new Error('--enhance requires regen:/absolute/model.onnx');
  const model = path.resolve(value.slice(6));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(model)) hash.update(chunk);
  return { model, identity: `regen-rgb-minus1-plus1-u8-v1:${hash.digest('hex')}` };
}

export async function startAppearance(spec: AppearanceSpec, temporary: string, runDir: string, log: (line: string) => void): Promise<AppearanceSession> {
  const socket = path.join(temporary, 'appearance.sock');
  const child = spawn(process.env['SIMFORGE_APPEARANCE_PYTHON'] ?? 'python3', [
    path.join(repositoryRoot(), 'adapters/appearance/regen.py'), '--onnx', spec.model,
    '--socket', socket, '--metrics', path.join(runDir, 'appearance.jsonl'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stderr?.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-12000); log(`[appearance] ${String(chunk).trim()}`); });
  try {
    const { promise, resolve, reject } = promises.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(() => reject(new Error(`appearance startup timed out: ${errors}`)), 120_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`appearance exited ${code}: ${errors}`)); });
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
        const lines = output.split('\n');
        output = lines.pop()!;
        for (const line of lines) {
          log(`[appearance] ${line}`);
          if (!line.startsWith('READY ')) continue;
          try {
            const ready = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (ready['identity'] !== spec.identity) throw new Error('appearance checkpoint identity changed before startup');
            clearTimeout(timer);
            resolve(ready);
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
    const runtime = await promise;
    if (!(await fs.stat(socket)).isSocket()) throw new Error('appearance READY did not bind a socket');
    await fs.writeFile(path.join(runDir, 'appearance-runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
    return { child, socket, identity: spec.identity };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

export async function enhanceOffline(options: { runDir: string; cosmosRoot?: string; out?: string; sensor?: string; prompt?: string; prepareOnly?: boolean }): Promise<number> {
  const args = [path.join(repositoryRoot(), 'adapters/appearance/cosmos.py'), path.resolve(options.runDir)];
  for (const [flag, value] of [['--cosmos-root', options.cosmosRoot], ['--out', options.out], ['--sensor', options.sensor], ['--prompt', options.prompt]] as const) {
    if (value !== undefined) args.push(flag, value);
  }
  if (options.prepareOnly) args.push('--prepare-only');
  const child = spawn(process.env['SIMFORGE_APPEARANCE_PYTHON'] ?? 'python3', args, { stdio: 'inherit' });
  const { promise, resolve, reject } = promises.withResolvers<number>();
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
  return promise;
}
