/** Real WebGL regression: deferred cleanup from a discarded StrictMode mount
 * must never lose the context now owned by its same-canvas successor.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Checks } from './texture-tier-assertions';
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const script = await build({ stdin: { resolveDir: join(import.meta.dirname, '..'), contents: `
  import { CityViewer } from '../packages/viewer/src/viewer';
  import { AmbientLight, BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
  (async () => {
    const canvas = document.querySelector('canvas');
    const first = new CityViewer(canvas);
    const initialContext = first.renderer.getContext();
    first.dispose();
    const successor = new CityViewer(canvas);
    const geometry = new BoxGeometry(2,2,2);
    const material = new MeshStandardMaterial({color:0xe0b070});
    const cube = new Mesh(geometry,material);
    successor.scene.add(cube,new AmbientLight(0xffffff,3));
    try {
      const pause = Promise.withResolvers();
      setTimeout(pause.resolve,250);
      await pause.promise;
      successor.camera.position.set(0,2,6);
      successor.camera.lookAt(0,0,0);
      successor.renderer.render(successor.scene,successor.camera);
      const pixel=document.createElement('canvas'); pixel.width=pixel.height=1;
      const context=pixel.getContext('2d');
      context.drawImage(canvas,canvas.width/2,canvas.height/2,1,1,0,0,1,1);
      window.result = {sameContext:initialContext===successor.renderer.getContext(), successorLost:successor.renderer.getContext().isContextLost(),
        programs:successor.renderer.info.programs.length,pixel:[...context.getImageData(0,0,1,1).data]};
    } finally { geometry.dispose();material.dispose();successor.dispose();canvas.remove(); }
  })().catch(error => {window.failure=String(error)});
` }, bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'import.meta.url': JSON.stringify('http://127.0.0.1/__viewer-context-lifetime') } });
const browser = await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas style="width:160px;height:120px"></canvas>');
  await page.addScriptTag({ content: script.outputFiles[0]!.text });
  await page.waitForFunction('window.result || window.failure');
  const result = await page.evaluate('({result:window.result,failure:window.failure})') as { result?: { sameContext: boolean; successorLost: boolean; programs: number; pixel: number[] }; failure?: string };
  const checks = new Checks();
  checks.check('same-canvas replacement retains its live WebGL context', result, () => {
    assert(!result.failure, result.failure);
    assert.equal(result.result?.sameContext, true, 'fixture must exercise the shared-context lifetime');
    assert.equal(result.result?.successorLost, false, 'discarded viewer cleanup killed the successor');
    assert(result.result!.programs > 0, 'successor must compile a real lit program');
    assert(Math.max(...result.result!.pixel.slice(0, 3)) > 20 && result.result!.pixel[3] === 255, 'successor must paint lit geometry');
  });
  if (args.get('out')) await writeFile(args.get('out')!, JSON.stringify({ result, checks: checks.results }, null, 2));
  checks.finish();
} finally { await browser.close(); }
