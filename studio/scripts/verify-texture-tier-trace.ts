/** Replay a captured real-browser trace through the same dimension/byte gates.
 * pnpm verify:texture-tier-trace --trace=/tmp/drive-quality/g48-trace.json --target=256
 * Exit 1 on the pre-fix all-128 capture is intentional; never turn it into PASS.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertDimensions, Checks } from './texture-tier-assertions';

const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
assert(args.has('trace'), '--trace=<captured real-browser trace.json> is required');
const trace = JSON.parse(await readFile(args.get('trace')!, 'utf8')) as {
  samples: { readyAt: number | null }[];
  trace: { n: string; end?: number; info?: { url?: string; bytes?: number; w?: number; h?: number } }[];
};
const ready = trace.samples.find(row => row.readyAt !== null)?.readyAt;
assert(typeof ready === 'number', 'trace has no ready timestamp');
const completed = trace.trace.filter(row => row.end !== undefined && row.end <= ready);
const fetched = completed.filter(row => row.n === 'texture.fetch');
const transcoded = completed.filter(row => row.n === 'texture.transcode');
const distinct = new Set(completed.filter(row => row.n === 'texture.load').map(row => row.info?.url));
assert(!distinct.has(undefined), 'texture.load is missing source identity');
const dimensions: Record<string, number> = {};
for (const row of transcoded) {
  const dimension = `${row.info?.w}x${row.info?.h}`;
  dimensions[dimension] = (dimensions[dimension] ?? 0) + 1;
}
const bytes = fetched.reduce((sum, row) => sum + (row.info?.bytes ?? NaN), 0);
const retained = transcoded.reduce((sum, row) => sum + (row.info?.bytes ?? NaN), 0);
const checks = new Checks();
checks.check('trace records explicit texture traffic, not /3d/ filter', { ready, distinct: distinct.size, fetched: fetched.length, bytes, retained, dimensions }, () => {
  assert(Number.isFinite(bytes) && bytes > 0);
  assert(Number.isFinite(retained) && retained > 0);
  if (args.has('calibrate-g48')) {
    assert.equal(distinct.size, 2119);
    assert.equal(fetched.length, 2119);
    assert.equal(bytes, 1_387_349_690);
    assert.equal(retained, 22_762_246);
  }
});
checks.check('actual texture dimensions match tier', dimensions, () => assertDimensions(dimensions, Number(args.get('target') ?? 256)));
checks.finish();
