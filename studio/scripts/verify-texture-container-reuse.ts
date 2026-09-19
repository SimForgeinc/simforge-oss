/** Real KTX2 loads through the shipped loader at 256 and 512, one URL.
 * The pre-fix url|mip-limit cache MUST fail this gate with two fetches.
 * --root=<throwaway daemon> --texture-url=<real served KTX2> [--chromium=...]
 * Fresh worktrees: run `node studio/scripts/sync-studio-assets.mjs` first.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { assertNoDuplicateFetches, Checks } from './texture-tier-assertions';
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
assert(args.get('root') && args.get('texture-url'), '--root and --texture-url are required');
const host = JSON.parse(await readFile(join(args.get('root')!, 'host.json'), 'utf8')) as { baseUrl: string; controlToken: string };
const base = new URL(host.baseUrl);
assert(base.hostname === '127.0.0.1' && Number(base.port) >= 5514 && Number(base.port) <= 5517);
const url = new URL(args.get('texture-url')!, base);
assert.equal(url.origin, base.origin, 'texture must be served by the real isolated daemon');
const basis = await fetch(new URL('/basis/basis_transcoder.wasm', base), { method: 'HEAD', headers: { authorization: `Bearer ${host.controlToken}` } });
assert(basis.ok, 'Basis runtime missing: run node studio/scripts/sync-studio-assets.mjs in the daemon worktree');
const browser = await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const context = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${host.controlToken}` } });
  const page = await context.newPage();
  const rows: { url: string; bytes: number }[] = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const byId = new Map<string, { url: string; bytes: number }>();
  cdp.on('Network.requestWillBeSent', event => {
    if (event.request.url !== url.href) return;
    const row = { url: event.request.url, bytes: 0 };
    rows.push(row); byId.set(event.requestId, row);
  });
  cdp.on('Network.loadingFinished', event => { const row = byId.get(event.requestId); if (row) row.bytes = event.encodedDataLength; });
  await page.route(`${base.origin}/__texture-container-gate`, route => route.fulfill({ contentType: 'text/html', body: '<canvas id="canvas" width="64" height="64"></canvas>' }));
  await page.goto(`${base.origin}/__texture-container-gate`);
  page.on('console', message => console.log(`browser ${message.type()}: ${message.text()}`));
  page.on('pageerror', error => { console.error(`browser error: ${error.stack}`); void page.evaluate(message => { Object.assign(window, { failure: message }); }, error.message); });
  page.on('response', response => { if (response.status() >= 400) console.error(`HTTP ${response.status()} ${response.url()}`); });
  const script = await build({ stdin: { resolveDir: join(import.meta.dirname, '..'), sourcefile: 'container-gate.ts', contents: `
    import { WebGLRenderer } from 'three';
    import { getGLTFLoader, disposeSharedLoader } from '../packages/viewer/src/gltf';
    import { AssetDownloadTracker } from '../packages/viewer/src/download-progress';
    (async () => {
      const renderer = new WebGLRenderer({canvas:document.querySelector('canvas')});
      const tracker = new AssetDownloadTracker();
      const signal = new AbortController().signal;
      const results = [];
      try {
        for (const cap of [256, 512]) {
          const loader = getGLTFLoader(renderer, '/basis/', tracker, signal, cap);
          const texture = await loader.ktx2Loader.loadAsync(${JSON.stringify(url.href)});
          results.push({width:texture.image.width,height:texture.image.height});
        }
        window.result = {dimensions:results,glError:renderer.getContext().getError()};
      } catch(error) { window.failure = String(error); }
      finally { disposeSharedLoader(); renderer.dispose(); }
    })();
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'import.meta.url': JSON.stringify(`${base.origin}/__texture-container-gate`) } });
  await page.addScriptTag({ content: script.outputFiles[0]!.text });
  try {
    await page.waitForFunction('window.result || window.failure', undefined, { timeout: 60_000 });
  } catch (error) {
    console.error(`FAIL decoding real texture at both caps: ${JSON.stringify({ rows, state: await page.evaluate('({result:window.result,failure:window.failure})') })}`);
    throw error;
  }
  const result = await page.evaluate('({result:window.result,failure:window.failure})') as { result?: { dimensions: { width: number; height: number }[]; glError: number }; failure?: string };
  const checks = new Checks();
  checks.check('real container decoded at both requested caps', result, () => { assert(!result.failure, result.failure); assert.deepEqual(result.result?.dimensions, [{ width: 256, height: 256 }, { width: 512, height: 512 }]); assert.equal(result.result?.glError, 0); });
  checks.check('container fetched once across different caps', rows, () => { assert(rows.length > 0); assertNoDuplicateFetches(rows); });
  await writeFile(args.get('out') ?? join(args.get('root')!, 'texture-container-reuse.json'), JSON.stringify({ result, rows, checks: checks.results }, null, 2));
  checks.finish();
} finally { await browser.close(); }
