/**
 * The drive worker while its world is still being built.
 *
 * A page does not stop living during those seconds — focus changes pause and
 * resume the transport, the drive loop pushes pedals — and every one of those
 * commands used to be answered with "live world is not running", which the
 * page shows as a fatal error even though the world came up a moment later.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test worker/__tests__/live-world-worker-startup.test.ts
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import type { LiveWorldWorkerRequest, LiveWorldWorkerResponse } from '../../app/lib/live-world/worker-protocol';

let resolveSessions: (runtime: unknown) => void = () => {};
let rejectSessions: (error: Error) => void = () => {};
const applied: unknown[] = [];

mock.module('@simforge-oss/training-env/browser', {
  namedExports: {
    loadSessions: () => new Promise((resolve, reject) => {
      resolveSessions = resolve;
      rejectSessions = reject;
    }),
    TruthStreamClient: class { push() { return []; } },
  },
});
mock.module('@simforge-oss/playback', {
  namedExports: {
    loadMapGraph: async () => ({ graph: {}, collision: { diagnostics: { status: 'ready' } } }),
  },
});
mock.module('@simforge-oss/engine', {
  namedExports: {
    parseSimScenarioInput: (input: unknown) => input,
    isRoadActorKind: () => true,
  },
});

function fakeRuntime() {
  const world = {
    native: { setDriverCommand: () => {} },
    subscribeTruth: () => ({ pull: () => [], close: () => {}, stats: { dropped: 0 } }),
    time: () => 0,
    advance: () => {},
    applyCommand: (_source: string, _sequence: number, command: unknown) => {
      applied.push(command);
      return { ok: true };
    },
    setDriverCommand: (_source: string, _sequence: number, _actorId: string, command: unknown) => {
      applied.push({ held: command });
      return { ok: true };
    },
  };
  return { engine: { module: {} }, world: () => world };
}

const posted: LiveWorldWorkerResponse[] = [];
const intervals: unknown[] = [];
/** A worker global: the real globals underneath, the worker's message port on top. */
const scope = Object.assign(Object.create(globalThis) as typeof globalThis, {
  onmessage: null as ((event: MessageEvent<LiveWorldWorkerRequest>) => void) | null,
  postMessage: (message: LiveWorldWorkerResponse) => posted.push(message),
  close: () => {},
});

const input = {
  clipSeconds: 20,
  dt: 0.02,
  actors: [{ id: 'ego', kind: 'car', tags: [], spawn: { kind: 'route' } }],
};

let generation = 0;
async function bootWorker() {
  (globalThis as { self?: unknown }).self = scope;
  // A fresh module instance per test: the worker keeps its world in module state.
  await import(`../live-world-worker.ts?generation=${generation++}`);
  const send = (message: LiveWorldWorkerRequest) => scope.onmessage!({ data: message } as MessageEvent<LiveWorldWorkerRequest>);
  send({ type: 'init-authored', input: input as never, mapSources: {} as never, tickHz: 50, endless: true });
  return send;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  posted.length = 0;
  applied.length = 0;
  mock.method(globalThis, 'setInterval', (handler: unknown) => {
    intervals.push(handler);
    return 0 as never;
  });
});

describe('live world worker start-up', () => {
  it('holds commands sent while the world is starting and applies them once it is up', async () => {
    const send = await bootWorker();
    send({ type: 'transport', action: 'stop' });
    send({ type: 'transport', action: 'play' });
    for (let frame = 0; frame < 120; frame += 1) {
      send({ type: 'driver-command', actorId: 'ego', command: { steer: 0, throttle: frame / 120, brake: 0, handbrake: false } });
    }
    await flush();
    assert.deepEqual(posted.filter((message) => message.type === 'error'), []);

    resolveSessions(fakeRuntime());
    for (let index = 0; index < 5; index += 1) await flush();
    assert.deepEqual(posted.filter((message) => message.type === 'error'), []);
    assert.ok(posted.some((message) => message.type === 'ready'));
    // The transport's last word was "play", and only the newest pedal state is replayed.
    const transport = posted.filter((message) => message.type === 'transport').at(-1);
    assert.equal(transport?.type === 'transport' && transport.playing, true);
    assert.deepEqual(
      applied.filter((command) => (command as { held?: unknown }).held !== undefined),
      [{ held: { steer: 0, throttle: 119 / 120, brake: 0, handbrake: false } }],
    );
  });

  it('reports why the world failed to start, once, and nothing generic after it', async () => {
    const send = await bootWorker();
    send({ type: 'transport', action: 'play' });
    rejectSessions(new Error('simforge wasm failed to instantiate: out of memory'));
    for (let index = 0; index < 5; index += 1) await flush();
    send({ type: 'transport', action: 'stop' });
    send({ type: 'driver-command', actorId: 'ego', command: null });
    assert.deepEqual(
      posted.filter((message) => message.type === 'error'),
      [{ type: 'error', message: 'simforge wasm failed to instantiate: out of memory' }],
    );
  });
});
