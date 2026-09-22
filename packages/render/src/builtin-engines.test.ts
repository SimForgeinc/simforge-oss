import { describe, expect, it } from 'vitest';

import { assertEngineSupportsIntent, UnsupportedRenderIntentError } from './capabilities.js';
import { loadBuiltinRenderEngine } from './builtin-engines.js';
import { cameraIntent } from './camera-test-fixture.js';

describe('CARLA camera profile preflight', () => {
  it('accepts a default profile and rejects an explicitly authored linear-RGB profile', async () => {
    const engine = await loadBuiltinRenderEngine('carla', { engineVersion: 'a'.repeat(40) });
    expect(() => assertEngineSupportsIntent(engine.capabilities, cameraIntent())).not.toThrow();
    expect(() => assertEngineSupportsIntent(engine.capabilities, cameraIntent('authored'))).toThrow(UnsupportedRenderIntentError);
    try {
      assertEngineSupportsIntent(engine.capabilities, cameraIntent('authored'));
    } catch (error) {
      expect((error as UnsupportedRenderIntentError).reasons).toContain('missing capability camera.output.linear_rgb');
    }
  });
});
