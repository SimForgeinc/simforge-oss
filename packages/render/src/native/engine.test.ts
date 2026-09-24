import type { RenderSourceV3 } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import {
  assertNativeSourcesSupported, assertNativeVideoProfileSupported, createRenderEngine, nativeCameraClipPlanes, nativeEncoderVersion,
  nativeTextureEvidence, nativeVramCapacity, resolveBinary, resolveNativeEncoder,
  nativeBundleBytes,
  nativeShmSizeMb,
} from './engine.js';
import { stripRgbaPadding } from './service-client.js';

describe('native retained engine adapter', () => {
  it('declares cameras, cast lidar/radar, and the artifact contract - not camera derivatives', () => {
    const engine = createRenderEngine({ binary: '/bin/true' });
    expect(engine.capabilities).toMatchObject({
      engineId: 'bevy-retained',
      backend: 'native',
      modalities: ['rgb', 'lidar', 'radar'],
      requiresGpu: true,
    });
    expect(engine.capabilities.capabilities).toEqual(expect.arrayContaining([
      'sensor.rgb', 'sensor.lidar', 'sensor.radar', 'artifact.video', 'artifact.manifest', 'artifact.trace', 'artifact.sensor_archive',
    ]));
    expect(engine.capabilities.capabilities).not.toEqual(expect.arrayContaining([
      'sensor.depth', 'sensor.semantic', 'sensor.instance',
    ]));
  });

  it('resolves the retained service binary from explicit options', () => {
    expect(resolveBinary({ binary: '/opt/simforge-render' })).toBe('/opt/simforge-render');
  });

  it('removes wgpu row padding before rawvideo encoding', () => {
    const width = 65;
    const height = 2;
    const stride = 512;
    const padded = Buffer.alloc(stride * height, 0xee);
    padded.fill(1, 0, width * 4);
    padded.fill(2, stride, stride + width * 4);
    const packed = stripRgbaPadding(padded, width, height);
    expect(packed).toHaveLength(width * height * 4);
    expect([...packed.subarray(0, width * 4)]).toEqual(new Array(width * 4).fill(1));
    expect([...packed.subarray(width * 4)]).toEqual(new Array(width * 4).fill(2));
  });
});

describe('native VRAM capacity', () => {
  const staged = { capacityBytes: 10 * 2 ** 30, capacitySource: 'assumed' as const, estimatedBytes: 6 * 2 ** 30 };
  it('checks against the measured device when it is smaller than the intent assumption', () => {
    expect(nativeVramCapacity(16 * 2 ** 30, 10 * 2 ** 30)).toEqual({ capacityBytes: 10 * 2 ** 30, detected: true, intentCapacity: 16 * 2 ** 30, measuredBytes: 10 * 2 ** 30 });
    expect(nativeVramCapacity(8 * 2 ** 30, 10 * 2 ** 30)).toEqual({ capacityBytes: 8 * 2 ** 30, detected: false, intentCapacity: 8 * 2 ** 30, measuredBytes: 10 * 2 ** 30 });
    expect(nativeVramCapacity(16 * 2 ** 30, undefined)).toEqual({ capacityBytes: 16 * 2 ** 30, detected: false, intentCapacity: 16 * 2 ** 30, measuredBytes: undefined });
  });

  it('reports the measured device to a plane that accepts it, whenever it was measured', () => {
    const features = new Set(['native-evidence.vram-detected']);
    const vram = nativeVramCapacity(16 * 2 ** 30, 10 * 2 ** 30);
    expect(nativeTextureEvidence(staged, vram, false, features))
      .toMatchObject({ capacityBytes: 16 * 2 ** 30, capacitySource: 'assumed', detectedCapacityBytes: 10 * 2 ** 30 });
    // An older plane parses the enum strictly: it sees the baseline evidence.
    expect(nativeTextureEvidence(staged, vram, false, new Set()))
      .toMatchObject({ capacityBytes: 16 * 2 ** 30, capacitySource: 'assumed' });
    expect(nativeTextureEvidence(staged, vram, false, new Set())).not.toHaveProperty('detectedCapacityBytes');
    // A 10 GiB fleet on a 10 GiB card (box 3's dev worker): the intent's
    // capacity is the check, and the measured device is still reported.
    const same = nativeVramCapacity(10 * 2 ** 30, 10 * 2 ** 30);
    expect(nativeTextureEvidence(staged, same, false, features))
      .toMatchObject({ capacityBytes: 10 * 2 ** 30, capacitySource: 'assumed', detectedCapacityBytes: 10 * 2 ** 30 });
    // An explicit budget stays the check; the measured device is reported beside it.
    expect(nativeTextureEvidence({ ...staged, capacityBytes: 6 * 2 ** 30, capacitySource: 'explicit' as const }, nativeVramCapacity(6 * 2 ** 30, 10 * 2 ** 30), true, features))
      .toMatchObject({ capacityBytes: 6 * 2 ** 30, capacitySource: 'explicit', detectedCapacityBytes: 10 * 2 ** 30 });
    // Nothing measured: absent (and the run warns gpu_memory_unmeasured).
    expect(nativeTextureEvidence(staged, nativeVramCapacity(16 * 2 ** 30, undefined), false, features)).not.toHaveProperty('detectedCapacityBytes');
  });
});

describe('native engine input policy', () => {
  const camera = (outputName: string, { nearM = 0.1, farM = 800, width = 1280, rollRad = 0 }: Partial<{ nearM: number; farM: number; width: number; rollRad: number }> = {}): RenderSourceV3 => ({
    actorId: 'ego', sensorId: outputName, outputName, modality: 'rgb',
    transform: { position: { x: 1, y: 1.4, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad } },
    attributes: { width, height: 720, fps: 24, horizontalFovDeg: 90, nearM, farM },
  });
  const radar: RenderSourceV3 = {
    actorId: 'ego', sensorId: 'radar', outputName: 'radar', modality: 'radar',
    transform: { position: { x: 2, y: 0.5, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
    attributes: { horizontalFovDeg: 60, verticalFovDeg: 10, rangeM: 150, pointsPerSecond: 1500 },
  };

  it('takes the clip planes from the RGB cameras alone: a radar never moves them', () => {
    expect(nativeCameraClipPlanes([camera('front'), radar, camera('rear')])).toEqual({ nearM: 0.1, farM: 800 });
  });

  it('refuses cameras that ask for different clip planes (the service renders one pair)', () => {
    expect(() => nativeCameraClipPlanes([camera('front'), camera('rear', { nearM: 0.5 })]))
      .toThrow(expect.objectContaining({ code: 'native_camera_clip_planes_conflict' }));
  });

  it('accepts a rolled camera and refuses a camera larger than the engine renders', () => {
    expect(() => assertNativeSourcesSupported([camera('front', { rollRad: 0.05 })])).not.toThrow();
    expect(() => assertNativeSourcesSupported([camera('front', { width: 8192 })]))
      .toThrow(expect.objectContaining({ code: 'native_camera_size_unsupported' }));
    expect(() => assertNativeSourcesSupported([camera('front'), radar])).not.toThrow();
  });

  it('never spawns a bare ffmpeg: no resolvable encoder fails the job', () => {
    expect(() => resolveNativeEncoder({}, { PATH: '', SIMFORGE_NATIVE_RUNTIME_ROOT: '/nonexistent-simforge-runtime' }))
      .toThrow(expect.objectContaining({ code: 'native_encoder_missing' }));
    expect(resolveNativeEncoder({ ffmpegBinary: '/opt/ffmpeg' }, {})).toEqual({ path: '/opt/ffmpeg', source: 'option' });
    expect(() => nativeEncoderVersion('/nonexistent/ffmpeg')).toThrow(expect.objectContaining({ code: 'native_encoder_missing' }));
  });

  it('encodes only the video profile it can make: mp4+h264 up to high quality', () => {
    const video = { width: 1280, height: 720, fps: 24, container: 'mp4', codec: 'h264', quality: 'high' } as const;
    expect(() => assertNativeVideoProfileSupported(video)).not.toThrow();
    expect(() => assertNativeVideoProfileSupported({ ...video, container: 'webm', codec: 'vp9' }))
      .toThrow(expect.objectContaining({ code: 'native_video_profile_unsupported' }));
    expect(() => assertNativeVideoProfileSupported({ ...video, quality: 'lossless' }))
      .toThrow(expect.objectContaining({ code: 'native_video_quality_unsupported' }));
  });
});

describe('native shared-memory ring sizing', () => {
  const rgb = (width: number, height: number) => ({ modality: 'rgb', attributes: { width, height } });
  // The PhysicalAI-AV rig: 7 x 1920x1080 cameras, 1 lidar, 9 radars.
  const pai = [...Array.from({ length: 7 }, () => rgb(1920, 1080)), ...Array.from({ length: 10 }, () => ({ modality: 'lidar', attributes: {} }))];

  it('sizes the ring from the rig so pipelining is never dropped for a large rig', () => {
    const bytes = nativeBundleBytes(pai);
    expect(bytes).toBe(7 * 1920 * 4 * 1080 + 10 * 8 * 1024 * 1024);
    const mb = nativeShmSizeMb(bytes, 2);
    expect(mb * 1024 * 1024).toBeGreaterThanOrEqual(5 * bytes);
    expect(mb % 64).toBe(0);
    expect(mb).toBeGreaterThan(512);
  });

  it('keeps the default for a small rig and for serial ticks', () => {
    expect(nativeShmSizeMb(nativeBundleBytes([rgb(512, 384), rgb(512, 384)]), 2)).toBe(512);
    expect(nativeShmSizeMb(nativeBundleBytes(pai), 0)).toBe(512);
  });

  it('fails loudly when an explicit ring is too small for the requested lookahead', () => {
    expect(() => nativeShmSizeMb(nativeBundleBytes(pai), 2, 512)).toThrow(/native_shm_too_small|cannot hold/);
    expect(nativeShmSizeMb(nativeBundleBytes(pai), 0, 512)).toBe(512);
  });
});
