import { DataTexture, type WebGLRenderer } from 'three';
import { expect, it } from 'vitest';
import { inspectAlbedoTexture, registerAlbedoTexture } from './albedo-color';

it('reports existing GPU failures separately instead of blaming a healthy albedo texture', () => {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  registerAlbedoTexture(texture);
  const pending = [1281, 1282, 0];
  const renderer = {
    getContext: () => ({ NO_ERROR: 0, getError: () => pending.shift() ?? 0 }),
    getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    getViewport: () => undefined, getScissor: () => undefined, getScissorTest: () => false,
    getClearColor: () => undefined, getClearAlpha: () => 1,
    setClearColor: () => undefined, setScissorTest: () => undefined, setRenderTarget: () => undefined,
    setViewport: () => undefined, setScissor: () => undefined, render: () => undefined,
    readRenderTargetPixels: (_target: unknown, _x: number, _y: number, _w: number, _h: number, pixels: Uint8Array) => pixels.set([255, 255, 255, 255]),
    xr: { enabled: false }, shadowMap: { autoUpdate: false, needsUpdate: false },
  } as unknown as WebGLRenderer;
  try {
    expect(() => inspectAlbedoTexture(renderer, texture)).toThrowError(expect.objectContaining({
      name: 'PriorWebGLError', message: expect.stringContaining('1281, 1282'),
    }));
    expect(pending).toEqual([]);
  } finally { texture.dispose(); }
});
