import type { RenderIntentV1, RenderSourceV3 } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { NATIVE_ACTOR_ASSETS_INPUT_ID, PINNED_ACTOR_ASSETS_DIGEST, PINNED_ACTOR_ASSETS_SIZE_BYTES } from './actor-assets.js';
import {
  NativeRunDiagnosticsSchema,
  nativeEvidenceFailure,
  nativeRunExpectations,
  type NativeRenderManifest,
  type NativeReservedArtifact,
  type NativeRunDiagnostics,
} from './evidence.js';
import { NATIVE_SERVICE_PROTOCOL } from './service-client.js';

const HEX = (fill: string): string => fill.repeat(64);

function camera(sensorId: string, fps: number): RenderSourceV3 {
  return {
    actorId: 'ego',
    sensorId,
    outputName: `ego-${sensorId}`,
    modality: 'rgb',
    transform: { position: { x: 1.6, y: 0, z: 1.7 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
    attributes: { width: 320, height: 180, fps, horizontalFovDeg: 90, nearM: 0.1, farM: 1_000 },
  };
}

/** 12 fps and 24 fps over two seconds: 24 and 48 frames whose union is the 48-tick timeline. */
const intent: RenderIntentV1 = {
  schema: 'simforge.render-intent/v1',
  intentId: 'usri_native',
  executionPackage: { id: 'usepkg_native', sourceInputDigest: HEX('e') },
  scenarioRevision: {
    revisionId: 'usrev_native',
    scenarioSha256: HEX('e'),
    openScenario: { sha256: HEX('c'), sizeBytes: 1024 },
    map: { mapId: 'map-1', revisionId: 'usmapv_1', sha256: HEX('f') },
  },
  sensorHosts: ['ego-slow', 'ego-fast'].map((sourceId) => ({
    sourceId, actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.sedan' },
  })),
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [camera('slow', 12), camera('fast', 24)],
    clip: { startSeconds: 0, endSeconds: 2 },
    video: { width: 320, height: 180, fps: 24, container: 'mp4', codec: 'h264', quality: 'high' },
    artifacts: ['manifest', 'video', 'trace'],
    capabilityIntent: {
      required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'artifact.trace', 'timing.fixed_step'],
      preferred: [],
      fidelity: 'dataset',
    },
    authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
  },
  assets: [
    { assetId: 'map.tile.000000', kind: 'map', sha256: HEX('9'), sizeBytes: 2048 },
    { assetId: NATIVE_ACTOR_ASSETS_INPUT_ID, kind: 'catalog', sha256: PINNED_ACTOR_ASSETS_DIGEST, sizeBytes: PINNED_ACTOR_ASSETS_SIZE_BYTES },
  ],
  seed: 7,
};
const lease = { intentSha256: HEX('a'), executionPackageControlSha256: HEX('b') };
const traceSha256 = HEX('5');

const reservations: NativeReservedArtifact[] = [
  { role: 'video', actorId: 'ego', sensorId: 'slow', mediaType: 'video/mp4', sha256: HEX('1'), sizeBytes: 128 },
  { role: 'video', actorId: 'ego', sensorId: 'fast', mediaType: 'video/mp4', sha256: HEX('2'), sizeBytes: 256 },
  { role: 'trace', actorId: null, sensorId: null, mediaType: 'application/json', sha256: traceSha256, sizeBytes: 64 },
  { role: 'manifest', actorId: null, sensorId: null, mediaType: 'application/json', sha256: HEX('4'), sizeBytes: 512 },
  { role: 'diagnostics', actorId: null, sensorId: null, mediaType: 'application/json', sha256: HEX('6'), sizeBytes: 512 },
];

function evidence(overrides: { slowFrames?: number; actorAssetsSha256?: string } = {}): { manifest: NativeRenderManifest; diagnostics: NativeRunDiagnostics } {
  const slowFrames = overrides.slowFrames ?? 24;
  const lineage = {
    ...lease,
    sourceXoscSha256: HEX('c'),
    loweringSha256: HEX('d'),
    actorAssetsSha256: overrides.actorAssetsSha256 ?? PINNED_ACTOR_ASSETS_DIGEST,
    frameCount: 48,
  };
  return {
    manifest: {
      schema: 'simforge.native-render-manifest/v1',
      ...lineage,
      look: { profile: 'cinematic', lighting: {}, profileConfig: {}, autoMeter: true, provenance: {} },
      videos: [
        { actorId: 'ego', sensorId: 'fast', relativePath: 'video/ego-fast.mp4', width: 320, height: 180, framesPerSecond: 24, frameCount: 48, sha256: HEX('2'), sizeBytes: 256 },
        { actorId: 'ego', sensorId: 'slow', relativePath: 'video/ego-slow.mp4', width: 320, height: 180, framesPerSecond: 12, frameCount: slowFrames, sha256: HEX('1'), sizeBytes: 128 },
      ],
    },
    diagnostics: {
      schema: 'simforge.native-run-diagnostics/v1',
      ...lineage,
      fixedTimestepSeconds: 0.02,
      traceSha256,
      videoCount: 2,
      videos: [
        { actorId: 'ego', sensorId: 'fast', frameCount: 48, sha256: HEX('2') },
        { actorId: 'ego', sensorId: 'slow', frameCount: slowFrames, sha256: HEX('1') },
      ],
      service: { protocol: NATIVE_SERVICE_PROTOCOL, binary: '/opt/native-render-service' },
      frames: Array.from({ length: 48 }, (_, simTick) => ({ simTick, sceneRevision: 1, rigRevision: 1, generation: 1 })),
      timings: { wallMs: 1000, serverMs: 800 },
    },
  };
}

describe('native run expectations', () => {
  it('derives each source schedule, the union tick count and the pinned actor closure from the intent', () => {
    const expectations = nativeRunExpectations(intent, lease);
    expect(expectations.frameCount).toBe(48);
    expect(expectations.videos.get('ego\0slow')).toEqual({ width: 320, height: 180, framesPerSecond: 12, frameCount: 24 });
    expect(expectations.videos.get('ego\0fast')).toEqual({ width: 320, height: 180, framesPerSecond: 24, frameCount: 48 });
    expect(expectations.actorAssetsSha256).toBe(PINNED_ACTOR_ASSETS_DIGEST);
    expect(expectations.sourceXoscSha256).toBe(HEX('c'));
  });

  it('refuses an intent that never pinned its actor closure', () => {
    expect(() => nativeRunExpectations({ ...intent, assets: intent.assets.slice(0, 1) }, lease))
      .toThrow('native_actor_assets_undeclared');
  });
});

describe('native evidence acceptance', () => {
  it('accepts each video on its own schedule while the run covers the union timeline', () => {
    const { manifest, diagnostics } = evidence();
    expect(nativeEvidenceFailure(reservations, manifest, diagnostics, nativeRunExpectations(intent, lease))).toBeNull();
  });

  it('rejects a video that claims the union tick count instead of its source schedule', () => {
    const { manifest, diagnostics } = evidence({ slowFrames: 48 });
    expect(nativeEvidenceFailure(reservations, manifest, diagnostics, nativeRunExpectations(intent, lease)))
      .toBe('native_diagnostics_evidence_mismatch');
  });

  it('rejects evidence rendered with a different actor closure than the intent pinned', () => {
    const { manifest, diagnostics } = evidence({ actorAssetsSha256: HEX('8') });
    expect(nativeEvidenceFailure(reservations, manifest, diagnostics, nativeRunExpectations(intent, lease)))
      .toBe('native_diagnostics_evidence_mismatch');
  });

  it('rejects an incomplete artifact set before comparing evidence', () => {
    const { manifest, diagnostics } = evidence();
    const withoutTrace = reservations.filter((item) => item.role !== 'trace');
    expect(nativeEvidenceFailure(withoutTrace, manifest, diagnostics, nativeRunExpectations(intent, lease)))
      .toBe('native_artifact_evidence_incomplete');
  });

  it('only parses diagnostics that speak the protocol this client speaks', () => {
    const { diagnostics } = evidence();
    expect(NativeRunDiagnosticsSchema.safeParse({ ...diagnostics, service: { ...diagnostics.service, protocol: 2 } }).success).toBe(false);
    expect(NativeRunDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
  });
});
