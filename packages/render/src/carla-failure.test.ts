import { describe, expect, it } from 'vitest';

import { RenderArtifactManifestSchema } from './artifacts.js';
import { carlaRenderFailure } from './builtin-engines.js';
import { RenderInputError } from './render-input-error.js';

describe('CARLA policy refusals', () => {
  it('turn the adapter failure record into a non-retryable coded error', () => {
    const stdout = 'progress…\n' + JSON.stringify({
      schema: 'simforge.carla-render-failure/v1',
      code: 'carla_blueprint_unavailable',
      message: '[carla_blueprint_unavailable] actor car-1: vehicle.bus has no blueprint in this CARLA image',
      retryable: false,
    });
    const error = carlaRenderFailure(stdout);
    expect(error).toBeInstanceOf(RenderInputError);
    expect(error?.code).toBe('carla_blueprint_unavailable');
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain('vehicle.bus');
  });

  it('ignore stdout that is not a failure record', () => {
    expect(carlaRenderFailure('')).toBeUndefined();
    expect(carlaRenderFailure('{"schema":"other"}')).toBeUndefined();
    expect(carlaRenderFailure('not json')).toBeUndefined();
  });
});

describe('artifact manifest substitutions', () => {
  const base = {
    schema: 'simforge.render-artifact-manifest/v1',
    intentSha256: 'a'.repeat(64),
    engine: { engineId: 'carla', engineVersion: '1', backend: 'carla' },
    startedAt: '2026-09-22T00:00:00Z',
    completedAt: '2026-09-22T00:00:01Z',
    artifacts: [],
    warnings: [],
  };
  it('accept an allowed, recorded substitution', () => {
    expect(RenderArtifactManifestSchema.parse({
      ...base,
      substitutions: [{ kind: 'carla-actor-body', subject: 'car-1', requested: 'vehicle.bus', rendered: 'vehicle.mitsubishi.fusorosa', allowedBy: 'allowSubstitutions' }],
    }).substitutions).toHaveLength(1);
  });
  it('refuse a substitution kind the intent vocabulary does not know', () => {
    expect(() => RenderArtifactManifestSchema.parse({
      ...base,
      substitutions: [{ kind: 'actor-primitive', subject: 'car-1', requested: 'vehicle.bus', rendered: 'box', allowedBy: 'allowSubstitutions' }],
    })).toThrow();
  });
});
