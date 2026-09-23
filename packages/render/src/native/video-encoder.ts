import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/**
 * Video encoders for native render sources: one ffmpeg per source, raw RGBA
 * on stdin. `h264_nvenc` (GPU) is the default where the device supports it;
 * `libx264` (CPU) is the fallback and the reference.
 *
 * Quality equivalence: `libx264 -preset fast -crf 18` is the reference
 * setting. NVENC runs `-preset p5 -tune hq` in constant-quality VBR at
 * `NVENC_EQUIVALENT_CQ`, the value measured to match or exceed the reference's
 * SSIM against the raw frames on native renders (see the throughput report).
 * Both write yuv420p through the same swscale conversion, so the decoded
 * colour pipeline is identical.
 */
export type NativeVideoCodec = 'h264_nvenc' | 'libx264';
export type NativeVideoEncoderPreference = 'auto' | NativeVideoCodec;

export const NVENC_EQUIVALENT_CQ = 19;
/**
 * GeForce drivers cap concurrent NVENC sessions per system (8 since the 550
 * series). A job leaves headroom for co-tenants (CARLA presentation video,
 * another render on the same device); sources beyond the cap use libx264.
 */
export const DEFAULT_NVENC_MAX_SESSIONS = 6;
/** Frames retained for a libx264 replay while an NVENC session is unconfirmed. */
const NVENC_REPLAY_FRAMES = 48;

export interface VideoFormat {
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
}

export function encoderCodecArgs(codec: NativeVideoCodec): string[] {
  return codec === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(NVENC_EQUIVALENT_CQ), '-b:v', '0', '-profile:v', 'high', '-spatial-aq', '1', '-bf', '2']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
}

export function ffmpegEncodeArgs(codec: NativeVideoCodec, format: VideoFormat, outputPath: string): string[] {
  return [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${format.width}x${format.height}`,
    '-r', String(format.framesPerSecond), '-i', 'pipe:0',
    ...encoderCodecArgs(codec), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outputPath,
  ];
}

const nvencProbe = new Map<string, boolean>();

/**
 * Whether this ffmpeg can open an NVENC session on the visible GPU right now:
 * a one-frame encode to the null muxer (cached per binary for the process).
 */
export function nvencAvailable(ffmpeg: string): boolean {
  const cached = nvencProbe.get(ffmpeg);
  if (cached !== undefined) return cached;
  const probe = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=24:d=0.1',
    '-frames:v', '1', ...encoderCodecArgs('h264_nvenc'), '-pix_fmt', 'yuv420p', '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
  const ok = probe.status === 0;
  nvencProbe.set(ffmpeg, ok);
  return ok;
}

/**
 * Which codec each source gets: NVENC for the first `maxSessions` sources in
 * the given (priority) order when available and preferred, libx264 for the rest.
 */
export function assignVideoCodecs(
  sourceIds: readonly string[],
  options: { preference: NativeVideoEncoderPreference; nvenc: boolean; maxSessions: number },
): Map<string, NativeVideoCodec> {
  const assignment = new Map<string, NativeVideoCodec>();
  let sessions = 0;
  for (const sourceId of sourceIds) {
    const nvenc = options.preference !== 'libx264' && options.nvenc && sessions < options.maxSessions;
    if (nvenc) sessions += 1;
    assignment.set(sourceId, nvenc ? 'h264_nvenc' : 'libx264');
  }
  if (options.preference === 'h264_nvenc' && !options.nvenc) {
    throw new Error('native_video_encoder_unavailable: h264_nvenc was required but this ffmpeg cannot open an NVENC session');
  }
  return assignment;
}

/**
 * One ffmpeg encoder fed raw RGBA frames in order.
 *
 * An NVENC session can fail to open (the per-system session cap is shared
 * with other processes). Until ffmpeg reports its first encoded frame the
 * written frames are retained; if the NVENC process exits before that, the
 * source restarts on libx264 and replays them, so a busy encoder degrades to
 * the CPU path instead of failing the render. Frames are copied on write, so
 * a caller may reuse its buffer immediately.
 */
export class VideoEncoder {
  readonly path: string;
  readonly format: VideoFormat;
  #codec: NativeVideoCodec;
  #process: ChildProcessByStdio<Writable, null, Readable>;
  #stderr: string[] = [];
  #exit: Promise<[number | null, NodeJS.Signals | null]>;
  /** Frames written but not yet confirmed encoded (NVENC start-up window). */
  #retained: Buffer[] | null;
  #confirmed = false;
  #fellBack = false;
  #queue: Promise<void> = Promise.resolve();
  frames = 0;

  constructor(private readonly ffmpeg: string, outputPath: string, format: VideoFormat, codec: NativeVideoCodec) {
    this.path = outputPath;
    this.format = format;
    this.#codec = codec;
    this.#retained = codec === 'h264_nvenc' ? [] : null;
    ({ process: this.#process, exit: this.#exit } = this.#spawn(codec));
  }

  get codec(): NativeVideoCodec {
    return this.#codec;
  }

  /** True when the source started on NVENC and fell back to libx264. */
  get fellBack(): boolean {
    return this.#fellBack;
  }

  #spawn(codec: NativeVideoCodec): { process: ChildProcessByStdio<Writable, null, Readable>; exit: Promise<[number | null, NodeJS.Signals | null]> } {
    const args = ffmpegEncodeArgs(codec, this.format, this.path);
    // `-progress` on fd 2 alongside errors: `frame=N` lines confirm encoding.
    if (codec === 'h264_nvenc') args.splice(2, 0, '-progress', 'pipe:2', '-stats_period', '0.25');
    const child = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!this.#confirmed && codec === 'h264_nvenc' && /(^|\n)frame=[1-9]/u.test(chunk)) {
        this.#confirmed = true;
        this.#retained = null;
      }
      for (const line of chunk.split('\n')) {
        if (line.length === 0 || /^[a-z_]+=/u.test(line)) continue;
        this.#stderr.push(line);
        if (this.#stderr.length > 32) this.#stderr.shift();
      }
    });
    // A write to a dead encoder surfaces through `exit`, never as an unhandled EPIPE.
    child.stdin.on('error', () => undefined);
    const exit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    return { process: child, exit };
  }

  async #fallBack(): Promise<void> {
    const replay = this.#retained ?? [];
    this.#fellBack = true;
    this.#codec = 'libx264';
    this.#retained = null;
    this.#confirmed = true;
    ({ process: this.#process, exit: this.#exit } = this.#spawn('libx264'));
    for (const frame of replay) await this.#writeRaw(frame);
  }

  async #writeRaw(frame: Buffer): Promise<void> {
    const stdin = this.#process.stdin;
    if (stdin.write(frame)) return;
    const exited = this.#exit.then(() => 'exit' as const);
    const drained = once(stdin, 'drain').then(() => 'drain' as const);
    if ((await Promise.race([drained, exited])) === 'exit') throw new Error('encoder exited');
  }

  /** Queue one frame; resolves once ffmpeg accepted it (backpressure). */
  write(rgba: Buffer): Promise<void> {
    const frame = Buffer.from(rgba);
    const task = this.#queue.then(async () => {
      if (this.#retained) {
        this.#retained.push(frame);
        // An encoder that accepted this many frames has an open session.
        if (this.#retained.length > NVENC_REPLAY_FRAMES) {
          this.#retained = null;
          this.#confirmed = true;
        }
      }
      try {
        await this.#writeRaw(frame);
      } catch (error) {
        if (this.#codec === 'h264_nvenc' && !this.#confirmed) {
          await this.#exit;
          await this.#fallBack();
        } else {
          throw new Error(`ffmpeg (${this.#codec}) stopped accepting frames: ${this.#stderr.join('\n')}`, { cause: error });
        }
      }
      this.frames += 1;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** Flush and wait for the file; an NVENC start-up failure is retried on libx264. */
  async finish(): Promise<void> {
    await this.#queue;
    this.#process.stdin.end();
    let [code, signal] = await this.#exit;
    if (code !== 0 && this.#codec === 'h264_nvenc' && !this.#confirmed) {
      await this.#fallBack();
      this.#process.stdin.end();
      [code, signal] = await this.#exit;
    }
    if (code !== 0) {
      throw new Error(`ffmpeg (${this.#codec}) exited code=${String(code)} signal=${String(signal)}\n${this.#stderr.join('\n')}`);
    }
  }

  abort(): void {
    this.#process.stdin.destroy();
    this.#process.kill('SIGKILL');
  }
}
