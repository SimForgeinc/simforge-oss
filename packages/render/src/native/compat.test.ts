import { expect, it } from 'vitest';

import {
  CONTROL_FEATURES_V1, CONTROL_FEATURE_NATIVE_ENCODER, CONTROL_FEATURE_NATIVE_RENDER_CONFIG, CONTROL_FEATURE_NATIVE_SCENE_SOURCE, CONTROL_FEATURE_NATIVE_STAGE_TIMINGS,
  PrewarmSetSchema,
} from '../worker-control.js';
import { gatedRenderEvidence, gatedSceneSourceEvidence } from './engine.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema } from './evidence.js';

/**
 * Top-level keys the rc.72 control plane's strict native evidence schemas
 * accept. A worker must never write any other key unless the lease lists a
 * control feature for it; add new fields behind a feature, never here.
 */
const BASELINE_MANIFEST_KEYS = ['schema', 'intentSha256', 'executionPackageControlSha256', 'sourceXoscSha256', 'loweringSha256', 'actorAssetsSha256', 'frameCount', 'textureProfile', 'look', 'videos'];
const BASELINE_DIAGNOSTICS_KEYS = ['schema', 'intentSha256', 'executionPackageControlSha256', 'sourceXoscSha256', 'loweringSha256', 'actorAssetsSha256', 'frameCount', 'textureProfile', 'fixedTimestepSeconds', 'traceSha256', 'videoCount', 'videos', 'service', 'frames', 'timings'];
const GATED_KEYS = ['sceneSource', 'timelineSha256', 'parity', 'capture', 'encoder', 'render', 'exposure', 'roadDecals', 'textureResidency', 'frameIntegrity', 'luminaires'];
/** `timings` keys the rc.72 plane accepts; `stages` rides `native-evidence.stage-timings`. */
const BASELINE_TIMINGS_KEYS = ['wallMs', 'serverMs'];
const GATED_TIMINGS_KEYS = ['stages'];

it('every native evidence key is either baseline or gated behind a control feature', () => {
  for (const [schema, baseline] of [[NativeRenderManifestSchema, BASELINE_MANIFEST_KEYS], [NativeRunDiagnosticsSchema, BASELINE_DIAGNOSTICS_KEYS]] as const) {
    const unknown = Object.keys(schema.shape).filter((key) => !baseline.includes(key) && !GATED_KEYS.includes(key));
    expect(unknown, 'a new evidence field needs a control feature (worker-control.ts) and a gate in the engine').toEqual([]);
  }
});

it('every diagnostics timings key is either baseline or gated behind a control feature', () => {
  const timings = NativeRunDiagnosticsSchema.shape.timings;
  const unknown = Object.keys(timings.shape).filter((key) => !BASELINE_TIMINGS_KEYS.includes(key) && !GATED_TIMINGS_KEYS.includes(key));
  expect(unknown).toEqual([]);
  expect(CONTROL_FEATURES_V1).toContain(CONTROL_FEATURE_NATIVE_STAGE_TIMINGS);
});

it('gates the encoder record behind its own control feature', () => {
  expect(CONTROL_FEATURES_V1).toContain(CONTROL_FEATURE_NATIVE_ENCODER);
  expect(NativeRenderManifestSchema.shape.encoder.safeParse(undefined).success).toBe(true);
});

it('omits scene-source evidence for a control plane that did not list the feature', () => {
  expect(gatedSceneSourceEvidence(new Set(), 'render-timeline', 'a'.repeat(64))).toEqual({});
  expect(gatedSceneSourceEvidence(new Set(CONTROL_FEATURES_V1), 'render-timeline', 'a'.repeat(64))).toEqual({ sceneSource: 'render-timeline', timelineSha256: 'a'.repeat(64) });
  expect(gatedSceneSourceEvidence(new Set([CONTROL_FEATURE_NATIVE_SCENE_SOURCE]), 'openscenario-legacy', undefined)).toEqual({ sceneSource: 'openscenario-legacy' });
});

/**
 * Keys an rc.73 worker's strict `PrewarmSetSchema` accepts. The control plane
 * sends any other key only to a worker whose `prewarmFeatures` lists it.
 */
const BASELINE_PREWARM_SET_KEYS = ['setId', 'mapVersionId', 'mapId', 'closureSha256', 'objectCount', 'byteLength', 'createdAt', 'turnVerdictsSha256'];
const GATED_PREWARM_SET_KEYS = ['derivativesSha256'];

it('every prewarm set key is either baseline or gated behind a worker prewarm feature', () => {
  const unknown = Object.keys(PrewarmSetSchema.shape).filter((key) => !BASELINE_PREWARM_SET_KEYS.includes(key) && !GATED_PREWARM_SET_KEYS.includes(key));
  expect(unknown, 'a new prewarm set field needs a prewarm feature (worker-control.ts) and a gate in the control plane').toEqual([]);
});


it('writes the render config as rc.73 look keys for a plane without the render-config feature', () => {
  const look = { lighting: { weather: 'clear' }, autoMeter: true, provenance: {} };
  const request = { request: { preset: 'showcase' as const, set: { 'textures.tier': 'uastc-full' } }, geometryLod: 'auto' as const };
  const config = { preset: 'showcase', aa: { mode: 'smaa-ultra', taaSamples: 4 } };
  const legacy = gatedRenderEvidence(new Set(), look, request, config, undefined);
  expect(legacy).toEqual({ look: { profile: 'cinematic', ...look, profileConfig: config } });
  expect(NativeRenderManifestSchema.shape.look.safeParse(legacy.look).success).toBe(true);
  const current = gatedRenderEvidence(new Set([CONTROL_FEATURE_NATIVE_RENDER_CONFIG]), look, request, config, { manifestSha256: 'a'.repeat(64), buildKey: 'b'.repeat(64) });
  expect(current.look).toEqual({ profile: 'cinematic', ...look, profileConfig: config });
  expect(NativeRenderManifestSchema.shape.render.safeParse(current.render).success).toBe(true);
  expect(current.render?.geometryLod).toEqual({ mode: 'auto', manifestSha256: 'a'.repeat(64), buildKey: 'b'.repeat(64) });
});
