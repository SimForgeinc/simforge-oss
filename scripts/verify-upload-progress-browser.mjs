#!/usr/bin/env node
// Run after pnpm install: node scripts/verify-upload-progress-browser.mjs
// Exercises the authoritative source with real WebGL uploads and compilation.
// The pre-fix viewer never drains its three queued assets when pre-upload work
// exceeds uploadBudgetMs. No map download, cloud account, or GPU fleet is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsup')] }));
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.env.QA_VIEWER_BASELINE_REF;
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('QA_VIEWER_BASELINE_REF must be an exact commit');
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    resolveDir: `${root}/packages/viewer`,
    loader: 'ts',
    contents: `
      import { Box3, BoxGeometry, DataTexture, Mesh, MeshBasicMaterial, Vector3 } from 'three';
      import { CityViewer } from './src/viewer';
      import { TileStreamLayer } from './src/streaming';
      const canvas = document.querySelector('canvas');
      const viewer = new CityViewer(canvas, {
        cinematicLighting: false, realtimeShadows: false, antialias: false,
        maxPixelRatio: 1, uploadBudgetMs: 5, uploadPixelsPerFrame: 4,
      });
      const state = window.probe = { built: 0, submittedTextures: 0, drawn: [], frames: 0 };
      const layer = new TileStreamLayer({
        name: 'upload-progress-repro', renderer: viewer.renderer, scene: viewer.scene,
        defs: [0, 1, 2].map(i => ({
          id: 'tile-' + i, box: new Box3(new Vector3(-10, -10, -10), new Vector3(10, 10, 10)),
          lods: [{ level: 0, file: 'generated-in-memory', triangles: 12, fileSize: 256, geometricError: 0 }],
        })),
        build: async (def) => {
          const texture = new DataTexture(new Uint8Array([255, 64, 32, 255]), 1, 1);
          texture.needsUpdate = true;
          texture.onUpdate = () => { state.submittedTextures++; };
          const geometry = new BoxGeometry(40, 40, 40);
          const material = new MeshBasicMaterial({ map: texture });
          const object = new Mesh(geometry, material);
          object.position.x = (Number(def.id.slice(-1)) - 1) * 60;
          object.onAfterRender = () => {
            if (!state.drawn.includes(def.id)) state.drawn.push(def.id);
          };
          state.built++;
          return { object, resources: { geometries: [geometry], materials: [material], textures: [texture] },
            bytes: 256, pendingTextures: [texture] };
        },
        maxConcurrent: 3, pinCoarsest: true,
        memory: { admit: () => true, maxAssetBytes: () => 100000 },
      });
      // Use the real frame loop and real streaming layer, replacing only the
      // asset source and adding controlled CPU work before the upload phase.
      viewer.cityLayer = layer;
      viewer.cityGroup.add(layer.group);
      viewer.controls.setView([0, 100, 300], [0, 0, 0]);
      const update = viewer.controls.update.bind(viewer.controls);
      viewer.controls.update = dt => {
        update(dt);
        const until = performance.now() + 10;
        while (performance.now() < until) { /* deterministic pre-upload load */ }
      };
      viewer.onFrame = () => {
        state.frames++;
        state.stats = layer.stats();
        state.contextLost = viewer.renderer.getContext().isContextLost();
      };
      const gl = viewer.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      state.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      window.stopProbe = () => viewer.dispose();
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: baseline ? [{
    name: 'exact-viewer-baseline',
    setup(builder) {
      builder.onLoad({ filter: /packages\/viewer\/src\/viewer\.ts$/ }, () => ({
        contents: execFileSync('git', ['show', `${baseline}:packages/viewer/src/viewer.ts`], { cwd: root, encoding: 'utf8' }),
        loader: 'ts',
        resolveDir: `${root}/packages/viewer/src`,
      }));
    },
  }] : [],
});
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/probe.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/probe.js' ? bundle.outputFiles[0].contents
    : '<!doctype html><canvas style="width:640px;height:480px"></canvas><script type="module" src="/probe.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.bringToFront();
  try {
    await page.waitForFunction(() => {
      const p = window.probe;
      return p?.drawn.length === 3 && p.stats?.uploading === 0;
    }, null, { timeout: 15_000 });
  } finally {
    console.log(JSON.stringify(await page.evaluate(() => window.probe), null, 2));
  }
  const result = await page.evaluate(() => window.probe);
  assert.equal(result.built, 3);
  assert.equal(result.submittedTextures, 3);
  assert.equal(result.stats.residentTiles, 3);
  assert.equal(result.contextLost, false);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.stopProbe());
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
