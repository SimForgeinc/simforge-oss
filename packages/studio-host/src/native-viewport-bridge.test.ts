import { describe, expect, it, vi } from 'vitest';
import { nativeViewportProcessPort } from './native-viewport-bridge';

describe('native viewport process adapter', () => {
  it('forwards a valid camera command', async () => {
    const bridge = { start: vi.fn(async () => ({ ok: true as const })), camera: vi.fn(async () => ({ ok: true as const })), stop: vi.fn(async () => ({ ok: true as const })), onEvent: vi.fn(() => () => {}) };
    nativeViewportProcessPort(bridge).send({ command: 'camera', position: [1, 2, 3], target: [0, 0, 0] });
    await Promise.resolve();
    expect(bridge.camera).toHaveBeenCalledWith([1, 2, 3], [0, 0, 0]);
  });
  it('reports malformed camera vectors', async () => {
    const onError = vi.fn();
    const bridge = { start: vi.fn(), camera: vi.fn(async () => ({ ok: true as const })), stop: vi.fn(async () => ({ ok: true as const })), onEvent: vi.fn(() => () => {}) };
    nativeViewportProcessPort(bridge, onError).send({ command: 'camera', position: [1], target: [0, 0, 0] });
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(bridge.camera).not.toHaveBeenCalled();
  });
  it('routes rejected IPC to the error callback', async () => {
    const onError = vi.fn();
    const bridge = { start: vi.fn(), camera: vi.fn(async () => { throw new Error('rejected'); }), stop: vi.fn(async () => ({ ok: true as const })), onEvent: vi.fn(() => () => {}) };
    nativeViewportProcessPort(bridge, onError).send({ command: 'camera', position: [1, 2, 3], target: [0, 0, 0] });
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
  });
});
