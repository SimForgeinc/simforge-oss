import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { HEIGHT, WIDTH } from './profiles.js';

export interface LivePreview {
  readonly child: ChildProcess;
  write(frame: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Launch ffplay on raw RGBA frames; failure is surfaced instead of faking a UI. */
export async function startLivePreview(): Promise<LivePreview> {
  const child = spawn(process.env['SIMFORGE_FFPLAY_BINARY'] ?? 'ffplay', [
    '-loglevel', 'warning', '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', '10', '-i', 'pipe:0',
    '-window_title', 'SimForge drive bench',
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => { child.off('spawn', onSpawn); child.off('error', onError); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  return {
    child,
    async write(frame: Buffer): Promise<void> {
      if (!child.stdin || child.exitCode !== null) return;
      if (!child.stdin.write(frame)) await once(child.stdin, 'drain');
    },
    async close(): Promise<void> {
      child.stdin?.end();
      if (child.exitCode === null) {
        await Promise.race([
          once(child, 'exit').then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}
