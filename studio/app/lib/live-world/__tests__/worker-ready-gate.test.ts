import { describe, expect, it } from 'vitest';

import { WorkerReadyGate } from '../worker-ready-gate';

type Message = { type: string; value?: number; requestId?: number };

const gate = (limit?: number) => new WorkerReadyGate<Message>(
  (message) => (message.requestId === undefined && message.type !== 'begin-take' ? message.type : null),
  limit,
);

describe('worker ready gate', () => {
  it('holds messages until the world is up, then replays the newest intent of each kind in order', () => {
    const subject = gate();
    expect(subject.admit({ type: 'transport', value: 0 })).toBe('held');
    expect(subject.admit({ type: 'pedals', value: 1 })).toBe('held');
    expect(subject.admit({ type: 'begin-take' })).toBe('held');
    expect(subject.admit({ type: 'pedals', value: 2 })).toBe('held');
    expect(subject.admit({ type: 'transport', value: 3 })).toBe('held');
    expect(subject.open()).toEqual([
      { type: 'begin-take' },
      { type: 'pedals', value: 2 },
      { type: 'transport', value: 3 },
    ]);
    expect(subject.state).toBe('ready');
    expect(subject.admit({ type: 'pedals', value: 4 })).toBe('run');
    expect(subject.open()).toEqual([]);
  });

  it('keeps every exact message, up to its limit', () => {
    const subject = gate(2);
    expect(subject.admit({ type: 'spawn', requestId: 1 })).toBe('held');
    expect(subject.admit({ type: 'spawn', requestId: 2 })).toBe('held');
    expect(subject.admit({ type: 'spawn', requestId: 3 })).toBe('dropped');
    // Coalesced intents never count against it.
    expect(subject.admit({ type: 'pedals', value: 1 })).toBe('held');
    expect(subject.open().map((message) => message.requestId ?? message.type)).toEqual([1, 2, 'pedals']);
  });

  it('drops everything once the world has failed to start', () => {
    const subject = gate();
    subject.admit({ type: 'transport', value: 1 });
    subject.fail();
    expect(subject.state).toBe('failed');
    expect(subject.admit({ type: 'transport', value: 2 })).toBe('dropped');
    expect(subject.admit({ type: 'spawn', requestId: 9 })).toBe('dropped');
  });
});
