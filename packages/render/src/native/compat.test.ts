import { expect, it } from 'vitest';

import { CONTROL_FEATURES_V1, CONTROL_FEATURE_NATIVE_SCENE_SOURCE, PrewarmSetSchema } from '../worker-control.js';
import { gatedSceneSourceEvidence } from './engine.js';
import { NativeRenderManifestSchema, NativeRunDiagnosticsSchema } from './evidence.js';

/**
 * Top-level keys the rc.72 control plane's strict native evidence schemas
 * accept. A worker must never write any other key unless the lease lists a
 * control feature for it; add new fields behind a feature, never here.
 */
const BASELINE_MANIFEST_KEYS = ['schema', 'intentSha256', 'executionPackageControlSha256', 'sourceXoscSha256', 'loweringSha256', 'actorAssetsSha256', 'frameCount', 'textureProfile', 'look', 'videos'];
const BASELINE_DIAGNOSTICS_KEYS = ['schema', 'intentSha256', 'executionPackageControlSha256', 'sourceXoscSha256', 'loweringSha256', 'actorAssetsSha256', 'frameCount', 'textureProfile', 'fixedTimestepSeconds', 'traceSha256', 'videoCount', 'videos', 'service', 'frames', 'timings'];
const GATED_KEYS = ['sceneSource', 'timelineSha256', 'parity'];

it('every native evidence key is either baseline or gated behind a control feature', () => {
  for (const [schema, baseline] of [[NativeRenderManifestSchema, BASELINE_MANIFEST_KEYS], [NativeRunDiagnosticsSchema, BASELINE_DIAGNOSTICS_KEYS]] as const) {
    const unknown = Object.keys(schema.shape).filter((key) => !baseline.includes(key) && !GATED_KEYS.includes(key));
    expect(unknown, 'a new evidence field needs a control feature (worker-control.ts) and a gate in the engine').toEqual([]);
  }
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

