import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RenderIntentV1 } from '@simforge-oss/scenario';

import { nativeCaptureEvidence, nativeRenderRequest } from './engine.js';
import { VideoEncoder, assignVideoCodecs, encoderCodecArgs, ffmpegEncodeArgs } from './video-encoder.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in ffmpeg: NVENC "cannot open a session" (exits at once); libx264 copies stdin to the output. */
async function fakeFfmpeg(): Promise<{ binary: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-ffmpeg-'));
  temporary.push(dir);
  const binary = path.join(dir, 'ffmpeg');
  await writeFile(binary, [
    '#!/bin/sh',
    'for arg in "$@"; do out="$arg"; done',
    'case " $* " in *h264_nvenc*) echo "OpenEncodeSessionEx failed: out of memory (10)" >&2; exit 1;; esac',
    'cat > "$out"',
  ].join('\n'));
  await chmod(binary, 0o755);
  return { binary, dir };
}

describe('native video encoders', () => {
  it('gives NVENC to the first sources up to the session cap and libx264 to the rest', () => {
    const ids = ['cam-a', 'cam-b', 'cam-c', 'lidar'];
    expect([...assignVideoCodecs(ids, { preference: 'auto', nvenc: true, maxSessions: 2 }).values()])
      .toEqual(['h264_nvenc', 'h264_nvenc', 'libx264', 'libx264']);
    expect([...assignVideoCodecs(ids, { preference: 'auto', nvenc: false, maxSessions: 8 }).values()]).toEqual(Array(4).fill('libx264'));
    expect([...assignVideoCodecs(ids, { preference: 'libx264', nvenc: true, maxSessions: 8 }).values()]).toEqual(Array(4).fill('libx264'));
    expect(() => assignVideoCodecs(ids, { preference: 'h264_nvenc', nvenc: false, maxSessions: 8 })).toThrow(/native_video_encoder_unavailable/);
  });

  it('keeps libx264 at the reference setting and NVENC in constant-quality mode', () => {
    expect(encoderCodecArgs('libx264')).toEqual(['-c:v', 'libx264', '-preset', 'fast', '-crf', '18']);
    expect(encoderCodecArgs('h264_nvenc')).toEqual(expect.arrayContaining(['h264_nvenc', '-rc', 'vbr', '-cq', '-b:v', '0']));
    const args = ffmpegEncodeArgs('h264_nvenc', { width: 4, height: 2, framesPerSecond: 24 }, '/tmp/x.mp4');
    expect(args.slice(args.indexOf('-pix_fmt', 6), args.indexOf('-pix_fmt', 6) + 2)).toEqual(['-pix_fmt', 'yuv420p']);
  });

  it('falls back to libx264 and replays every frame when an NVENC session cannot open', async () => {
    const { binary, dir } = await fakeFfmpeg();
    const output = path.join(dir, 'out.raw');
    const encoder = new VideoEncoder(binary, output, { width: 2, height: 1, framesPerSecond: 24 }, 'h264_nvenc');
    const frame = Buffer.alloc(8);
    for (let index = 0; index < 5; index += 1) {
      frame.fill(index);
      await encoder.write(frame); // the caller reuses its buffer at once
    }
    await encoder.finish();
    expect(encoder.codec).toBe('libx264');
    expect(encoder.fellBack).toBe(true);
    expect(encoder.frames).toBe(5);
    const bytes = await readFile(output);
    expect([...bytes]).toEqual([0, 1, 2, 3, 4].flatMap((value) => Array(8).fill(value)));
  });
});

describe('native render request', () => {
  const intent = (extra: object) => ({ renderTextures: 'uastc-full', ...extra }) as unknown as RenderIntentV1;

  it('defaults to the showcase preset with geometry LOD auto, pinned to the staged texture tier', () => {
    expect(nativeRenderRequest(intent({}), {})).toEqual({
      request: { preset: 'showcase', set: { 'textures.tier': 'uastc-full' } }, geometryLod: 'auto',
    });
  });

  it('lets the intent override the worker default key by key', () => {
    const resolved = nativeRenderRequest(
      intent({ render: { preset: 'training', set: { 'aa.mode': 'taa' }, geometryLod: 'off' } }),
      { render: { preset: 'showcase', set: { 'aa.mode': 'smaa-high', 'ssr.enabled': false } } },
    );
    expect(resolved).toEqual({
      request: { preset: 'training', set: { 'aa.mode': 'taa', 'ssr.enabled': false, 'textures.tier': 'uastc-full' } },
      geometryLod: 'off',
    });
  });

  it('refuses a texture tier other than the one the job stages', () => {
    expect(() => nativeRenderRequest(intent({ render: { set: { 'textures.tier': 'bc7-512' } } }), {})).toThrow(expect.objectContaining({ code: 'native_render_config_invalid' }));
  });

  it('reads the capture evidence from the resolved config', () => {
    expect(nativeCaptureEvidence({ aa: { mode: 'taa', taaSamples: 4 }, clock: { mode: 'pinned' } }))
      .toEqual({ clock: 'simulation-time', antiAlias: 'taa', samplesPerFrame: 4 });
    expect(nativeCaptureEvidence({ aa: { mode: 'smaa-ultra', taaSamples: 4 }, clock: { mode: 'pinned' } }))
      .toEqual({ clock: 'simulation-time', antiAlias: 'smaa-ultra', samplesPerFrame: 1 });
    expect(nativeCaptureEvidence({ aa: { mode: 'taa', taaSamples: 4 }, clock: { mode: 'free' } }))
      .toEqual({ clock: 'update-count', antiAlias: 'taa', samplesPerFrame: 1 });
    expect(() => nativeCaptureEvidence({})).toThrow(/native_render_config_unreadable/);
  });
});
