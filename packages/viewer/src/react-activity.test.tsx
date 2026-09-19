// @vitest-environment jsdom
import { Activity, act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CityViewer as Viewer } from './viewer';

const state = vi.hoisted(() => ({ created: [] as Array<{ disposed: boolean; held: boolean; loads: number }>, rejectNext: false }));
vi.mock('./viewer', () => ({ CityViewer: class {
  disposed = false;
  held = false;
  loads = 0;
  renderer: { domElement: HTMLCanvasElement; getContext: () => { isContextLost: () => boolean } };
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = { domElement: canvas, getContext: () => ({ isContextLost: () => false }) };
    state.created.push(this);
  }
  setActivityHeld(held: boolean) { this.held = held; }
  async loadMap() {
    this.loads++;
    if (state.rejectNext) { state.rejectNext = false; throw new Error('transient map failure'); }
  }
  getCapabilities() { return []; }
  setWeatherAppearance() { if (this.disposed) throw new Error('WeatherController is disposed'); }
  dispose() { this.disposed = true; }
} }));
vi.mock('./viewer-diagnostics', () => ({ installViewerRuntimeDiagnostics: () => ({ mapLoadStarted() {}, mapLoadSucceeded() {}, dispose() {} }) }));
import { CityView } from './react';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
function Driver({ map = '/one' }: { map?: string }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => { viewer?.setWeatherAppearance(null); }, [viewer]);
  return <CityView manifestUrl={map} onReady={setViewer}
    onDisposed={released => setViewer(current => current === released ? null : current)} />;
}
function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { root, container };
}
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  state.created.length = 0;
  state.rejectNext = false;
});

it('reuses the complete live viewer and map across two Activity resumes, then disposes on retained-DOM removal', async () => {
  const { root, container } = mount();
  await act(async () => { root.render(<Activity mode="visible"><Driver /></Activity>); });
  const viewer = state.created[0]!;
  for (let cycle = 0; cycle < 2; cycle++) {
    await act(async () => { root.render(<Activity mode="hidden"><Driver /></Activity>); });
    expect(viewer.disposed).toBe(false);
    expect(viewer.held).toBe(true);
    await act(async () => { root.render(<Activity mode="visible"><Driver /></Activity>); });
    expect(state.created).toHaveLength(1);
    expect(viewer.held).toBe(false);
    expect(viewer.loads).toBe(1);
    expect(container.querySelector('canvas')?.style.visibility).not.toBe('hidden');
  }
  await act(async () => { root.render(<Activity mode="hidden"><Driver /></Activity>); });
  await act(async () => { root.render(null); });
  expect(viewer.disposed).toBe(true);
});

it('evicts the older held viewer on a second claim and clears retained consumer state before it resumes', async () => {
  const first = mount();
  await act(async () => { first.root.render(<Activity mode="visible"><Driver /></Activity>); });
  const old = state.created[0]!;
  await act(async () => { first.root.render(<Activity mode="hidden"><Driver /></Activity>); });
  const second = mount();
  await act(async () => { second.root.render(<Driver map="/two" />); });
  expect(old.disposed).toBe(true);
  await act(async () => { first.root.render(<Activity mode="visible"><Driver /></Activity>); });
  expect(first.container.querySelector('canvas')).not.toBeNull();
  expect(state.created[2]!.disposed).toBe(false);
});

it('retries a rejected load after Activity resume instead of caching the rejection as ready', async () => {
  const { root, container } = mount();
  state.rejectNext = true;
  await act(async () => { root.render(<Activity mode="visible"><Driver /></Activity>); });
  expect(container.querySelector('canvas')?.getAttribute('data-error')).toContain('transient map failure');
  expect(container.querySelector('canvas')?.style.visibility).toBe('hidden');
  await act(async () => { root.render(<Activity mode="hidden"><Driver /></Activity>); });
  await act(async () => { root.render(<Activity mode="visible"><Driver /></Activity>); });
  expect(state.created[0]!.loads).toBe(2);
  expect(container.querySelector('canvas')?.hasAttribute('data-error')).toBe(false);
  expect(container.querySelector('canvas')?.style.visibility).not.toBe('hidden');
});
