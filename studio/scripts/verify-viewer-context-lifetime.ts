/** Real WebGL lifetime regressions, independent of React/Next:
 * immediate replacement; delayed connected Activity restoration; portal
 * suspend/detach/reconnect; terminal detached disposal; connected page teardown.
 * Restore cases run twice. A disposed, detached canvas is terminal by contract;
 * portal reuse suspends the viewer instead of disposing it.
 * --viewer-root optionally selects another checkout for red/green verification;
 * by default the viewer under test is from this gate's own checkout.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Checks } from './texture-tier-assertions';
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const viewerRoot = resolve(args.get('viewer-root') ?? join(import.meta.dirname, '..', '..'));
const script = await build({ stdin: { resolveDir: join(viewerRoot, 'studio'), contents: `
  import { CityViewer } from '../packages/viewer/src/viewer';
  import { AmbientLight, BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
  function paint(viewer) {
    const geometry=new BoxGeometry(2,2,2),material=new MeshStandardMaterial({color:0xe0b070});
    const cube=new Mesh(geometry,material),light=new AmbientLight(0xffffff,3);
    viewer.scene.add(cube,light);
    try {
      viewer.camera.position.set(0,2,6);viewer.camera.lookAt(0,0,0);
      viewer.renderer.render(viewer.scene,viewer.camera);
      const canvas=viewer.renderer.domElement;
      const pixel=document.createElement('canvas');pixel.width=pixel.height=1;
      const context=pixel.getContext('2d');
      context.drawImage(canvas,canvas.width/2,canvas.height/2,1,1,0,0,1,1);
      return {lost:viewer.renderer.getContext().isContextLost(),programs:viewer.renderer.info.programs.length,pixel:[...context.getImageData(0,0,1,1).data]};
    } finally {viewer.scene.remove(cube,light);geometry.dispose();material.dispose();}
  }
  async function pause(ms) {const pending=Promise.withResolvers();setTimeout(pending.resolve,ms);await pending.promise;}
  (async () => {
    const canvas=document.querySelector('canvas');let viewer=new CityViewer(canvas);
    window.cycles=[];
    try {
      window.before=paint(viewer);
      if(window.lifecycleCase==='detached-exit'||window.lifecycleCase==='page-teardown') {
        if(window.lifecycleCase==='detached-exit')canvas.remove();
        viewer.dispose();await pause(250);
        window.exit={connected:canvas.isConnected,lost:viewer.renderer.getContext().isContextLost()};
      } else for(let cycle=1;cycle<=2;cycle++) {
        const row={cycle,before:paint(viewer)};window.cycles.push(row);
        const gl=viewer.renderer.getContext();
        if(window.lifecycleCase==='portal') {
          viewer.setRenderingSuspended(true);canvas.remove();await pause(250);
          row.away={connected:canvas.isConnected,lost:gl.isContextLost()};
          document.body.append(canvas);viewer.setRenderingSuspended(false);
        } else {
          viewer.dispose();if(window.lifecycleCase==='retained')await pause(250);
          row.away={connected:canvas.isConnected,lost:gl.isContextLost()};
          viewer=new CityViewer(canvas);
        }
        await pause(250);
        row.back={connected:canvas.isConnected,sameContext:gl===viewer.renderer.getContext(),...paint(viewer)};
      }
      window.done=true;
    } finally {
      // Intentionally leave retained canvases connected until page.close().
      // Page teardown must not depend on observing a DOM disconnect first.
      viewer.dispose();
    }
  })().catch(error=>{window.failure=String(error)});
` }, bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'import.meta.url': JSON.stringify('http://127.0.0.1/__viewer-context-lifetime') } });
interface Paint { lost: boolean; programs: number; pixel: number[] }
interface LifetimeEvidence {
  before?: Paint;
  cycles: { cycle: number; before: Paint; away?: { connected: boolean; lost: boolean }; back?: Paint & { connected: boolean; sameContext: boolean } }[];
  exit?: { connected: boolean; lost: boolean };
  failure?: string;
}
const browser = await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const checks = new Checks();
  const evidence: unknown[] = [];
  for (const lifecycleCase of ['immediate', 'retained', 'portal', 'detached-exit', 'page-teardown']) {
    const page = await browser.newPage();
    try {
      await page.setContent('<canvas style="width:160px;height:120px"></canvas>');
      await page.evaluate(value => Object.assign(window, { lifecycleCase: value }), lifecycleCase);
      await page.addScriptTag({ content: script.outputFiles[0]!.text });
      await page.waitForFunction('window.done || window.failure');
      const result = await page.evaluate('({before:window.before,cycles:window.cycles,exit:window.exit,failure:window.failure})') as LifetimeEvidence;
      evidence.push({ lifecycleCase, ...result });
      checks.check(`${lifecycleCase}: healthy lit starting frame`, result.before, () => {
        assert(result.before); assert.equal(result.before.lost, false); assert(result.before.programs > 0);
        assert(Math.max(...result.before.pixel.slice(0, 3)) > 20 && result.before.pixel[3] === 255);
      });
      if (lifecycleCase === 'detached-exit' || lifecycleCase === 'page-teardown') {
        checks.check(`${lifecycleCase}: cleanup honors canvas lifetime`, result, () => {
          assert(!result.failure, result.failure); assert(result.exit);
          assert.equal(result.exit.connected, lifecycleCase === 'page-teardown');
          assert.equal(result.exit.lost, lifecycleCase === 'detached-exit');
        });
      } else {
        for (const cycle of result.cycles) {
          checks.check(`${lifecycleCase}/${cycle.cycle}: away context survives`, cycle.away, () => {
            assert(cycle.away); assert.equal(cycle.away.connected, lifecycleCase !== 'portal');
            assert.equal(cycle.away.lost, false, 'disposal/suspension poisoned a reusable canvas');
          });
          checks.check(`${lifecycleCase}/${cycle.cycle}: same-context restoration paints lit geometry`, { back: cycle.back, failure: result.failure }, () => {
            assert(cycle.back, result.failure ?? 'restored renderer missing');
            assert(cycle.back.connected && cycle.back.sameContext); assert.equal(cycle.back.lost, false);
            assert(cycle.back.programs > 0);
            assert(Math.max(...cycle.back.pixel.slice(0, 3)) > 20 && cycle.back.pixel[3] === 255, 'compiled programs alone do not prove painted output');
          });
        }
        checks.check(`${lifecycleCase}: two consecutive restoration cycles complete`, { count: result.cycles.length, failure: result.failure }, () => {
          assert(!result.failure, result.failure); assert.equal(result.cycles.length, 2);
        });
      }
    } finally { await page.close(); }
  }
  if (args.get('out')) await writeFile(args.get('out')!, JSON.stringify({ evidence, checks: checks.results }, null, 2));
  checks.finish();
} finally { await browser.close(); }
