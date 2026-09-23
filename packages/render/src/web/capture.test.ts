import { describe, expect, it } from 'vitest';

import { awaitActorModels } from './capture.js';

type ModelState = 'loading' | 'ready' | 'failed';

function viewer(states: () => Record<string, ModelState>) {
  return {
    getStats: () => ({
      loadDiagnostics: {
        actorModels: Object.fromEntries(Object.entries(states())
          .filter(([, state]) => state !== 'ready')
          .map(([hash, state]) => [hash, { state, url: `https://models/${hash}.glb`, downgradeReason: `actor-model-${state}: ${hash}` }])),
      },
    }),
  } as never;
}

describe('browser capture actor models', () => {
  it('captures at once when every model is resident', async () => {
    await expect(awaitActorModels({ viewer: viewer(() => ({ a: 'ready' })), signal: new AbortController().signal })).resolves.toBe(false);
  });

  it('holds the frame until a loading model is resident', async () => {
    let polls = 0;
    const waited = awaitActorModels({ viewer: viewer(() => ({ a: (polls += 1) > 3 ? 'ready' : 'loading' })), signal: new AbortController().signal });
    await expect(waited).resolves.toBe(true);
  });

  it('refuses a failed model, and one that never arrives, instead of capturing its stand-in', async () => {
    await expect(awaitActorModels({ viewer: viewer(() => ({ a: 'failed' })), signal: new AbortController().signal }))
      .rejects.toThrow(/render_actor_model_unavailable: actor-model-failed/);
    await expect(awaitActorModels({ viewer: viewer(() => ({ a: 'loading' })), signal: new AbortController().signal }, 120))
      .rejects.toThrow(/render_actor_model_unavailable: 1 actor model\(s\) still loading/);
  });
});
