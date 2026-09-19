/** Runs the EXISTING navigation gate at 13ms and 100ms RTT.
 * --root=<throwaway-root> --port=<authorized-port> --map=<sourceMapId>
 * --other-map=<sourceMapId> --out=<evidence-directory> [--cdp=<loopback-url>]
 * --scope=full is the default. Explicit --scope=same-map omits ONLY the
 * different-map leg, retaining all five route cycles AND five editor/list cycles.
 * The real Create scenario UI creates one fixture document per latency run.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { verifyWorldNavigation } from './verify-world-navigation';
import type {} from '../../packages/viewer/src/viewer-diagnostics';
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = args.get('root'), mapId = args.get('map'), otherId = args.get('other-map'), output = args.get('out');
const port = Number(args.get('port'));
assert(root && mapId && otherId && output && Number.isInteger(port), '--root, --port, --map, --other-map and --out are required');
assert(!resolve(root).includes('/.local/share/simforge/'));
assert(port >= 1024 && ![5199, 5421, 5455, 8443].includes(port));
const scope = args.get('scope') ?? 'full';
assert(scope === 'full' || scope === 'same-map');
const host = JSON.parse(await readFile(join(root, 'host.json'), 'utf8')) as { baseUrl: string; controlToken: string };
const base = new URL(host.baseUrl);
assert(base.hostname === '127.0.0.1' && Number(base.port) === port);
const out = resolve(output);
assert(!out.startsWith(`${resolve(root)}/`), 'write borrowed-fixture evidence outside its root');
await mkdir(out, { recursive: true });
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
type Descriptor = { mapVersionId: string; sourceMapId: string; label: string; browserAssetRootUrl: string };
const { maps } = await api<{ maps: Descriptor[] }>('/api/simforge/maps');
const map = maps.find(map => map.sourceMapId === mapId);
const other = maps.find(map => map.sourceMapId === otherId);
assert(map && other && map !== other, 'both real fixture maps must be installed and distinct');
assert.equal([...maps].sort((a, b) => a.label.localeCompare(b.label))[0]?.mapVersionId, map.mapVersionId, 'gallery must initially select the requested fixture map');
const cdpUrl = args.get('cdp');
if (cdpUrl) {
  const endpoint = new URL(cdpUrl);
  assert(endpoint.hostname === '127.0.0.1' && Number(endpoint.port) >= 1024 && ![5199, 5421, 5455, 8443].includes(Number(endpoint.port)));
}
const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 })
  : await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
const results: unknown[] = [];
let failures = 0;
try {
  for (const latencyMs of [13, 100]) {
    const evidenceDir = join(out, String(latencyMs));
    await mkdir(evidenceDir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    try {
      const ticket = await api<{ url: string }>('/api/simforge/host/session', { next: '/dashboard/map-assets' });
      const result = await verifyWorldNavigation({ context, ticketUrl: ticket.url, map, other, out: evidenceDir, latencyMs, scope });
      const report = JSON.parse(await readFile(join(evidenceDir, 'world-navigation.json'), 'utf8')) as { samples: { editorCycle?: number; exitMs?: number; enterMs?: number }[]; skipped?: unknown[] };
      const editorCycles = report.samples.filter(sample => sample.editorCycle !== undefined);
      results.push({ latencyMs, passed: true, ...result, editorCycles, skipped: report.skipped ?? [] });
      console.log(`PASS retained navigation ${latencyMs}ms: ${JSON.stringify({ ...result, editorCycles, scope, skipped: report.skipped ?? [] })}`);
    } catch (error) {
      failures++;
      results.push({ latencyMs, passed: false, error: String(error) });
      console.error(`FAIL retained navigation ${latencyMs}ms: ${String(error)}`);
    } finally { await context.close(); }
  }
  await writeFile(join(out, 'summary.json'), JSON.stringify({ mapId, otherId, scope, results }, null, 2));
  assert.equal(failures, 0, `${failures} retained-navigation latency runs failed`);
} finally { await browser.close(); }
