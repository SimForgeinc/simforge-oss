/**
 * OpenSCENARIO conformance suite: SimForge vs the spec-derived oracle, with
 * esmini recorded as secondary evidence when it is installed.
 *
 *   pnpm osc-conformance:verify            # run every case, fail on unexpected verdicts
 *   pnpm osc-conformance:verify -- --case speed-linear-rate --keep
 *   pnpm osc-conformance:update-xosc       # rewrite the committed actions-profile exports
 *
 * The primary check (ours vs the ASAM-derived oracle) needs no third-party
 * simulator. esmini cross-checks and the trajectory round trip run only when
 * esmini is found; without it they are reported as skipped.
 * Exit codes: 0 all verdicts as recorded, 1 an unexpected verdict, 2 usage error. See
 * docs/engineering/openscenario-conformance.md.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLaneGraph } from '@simforge-oss/engine/node';
import { buildMapTopologyIndex } from '@simforge-oss/maps/topology';

import type { ConformanceCase } from '../src/tools/osc-conformance/cases.js';
import { locateEsmini } from '../src/tools/osc-conformance/esmini.js';
import { formatReport } from '../src/tools/osc-conformance/report.js';
import { straightRoadXodr } from '../src/tools/osc-conformance/road.js';
import { ROAD_FILE, runCase, type CaseResult } from '../src/tools/osc-conformance/run.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORPUS = path.join(REPO_ROOT, 'fixtures', 'osc-conformance');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const mode = process.argv[2] ?? 'verify';
if (mode !== 'verify' && mode !== 'update-xosc') {
  console.error(`usage: osc-conformance.ts verify|update-xosc [--case <id>] [--keep] [--json <out>] [--markdown <out>]`);
  process.exit(2);
}
const only = argValue('--case');
const keep = process.argv.includes('--keep');

const esmini = locateEsmini(REPO_ROOT);
if (!esmini) {
  console.log('osc-conformance: esmini not found (set SIMFORGE_ESMINI_BIN or run packages/openscenario/scripts-esmini/fetch-pinned-esmini.mjs); esmini cross-checks and round trips are SKIPPED, the spec oracle still runs.');
}

const caseFiles = readdirSync(path.join(CORPUS, 'cases')).filter((file) => file.endsWith('.case.json')).sort();
const cases: ConformanceCase[] = caseFiles
  .map((file) => JSON.parse(readFileSync(path.join(CORPUS, 'cases', file), 'utf8')) as ConformanceCase)
  .filter((testCase) => !only || testCase.id === only);
if (cases.length === 0) {
  console.error(`osc-conformance: no cases${only ? ` matching ${only}` : ''}`);
  process.exit(2);
}

const roadXodr = straightRoadXodr();
// The road sits next to every committed .xosc so LogicFile resolves for
// third-party players and checkers opening the files in place.
for (const dir of ['xosc', 'probes']) {
  const committedRoad = path.join(CORPUS, dir, ROAD_FILE);
  if (mode === 'update-xosc') {
    mkdirSync(path.dirname(committedRoad), { recursive: true });
    writeFileSync(committedRoad, roadXodr);
  } else if (!existsSync(committedRoad) || readFileSync(committedRoad, 'utf8') !== roadXodr) {
    console.error(`osc-conformance: ${path.relative(REPO_ROOT, committedRoad)} is stale; run update-xosc`);
    process.exit(1);
  }
}
const topology = buildMapTopologyIndex({ mapName: 'osc-conformance-straight', xodr: roadXodr.replace(/>\s*</g, '>\n<') });
const graph = buildLaneGraph(topology as never);

const scratch = mkdtempSync(path.join(tmpdir(), 'simforge-osc-conformance-'));
const results: CaseResult[] = [];
let staleXosc = 0;
try {
  for (const testCase of cases) {
    const { result, actionsXosc } = runCase({ testCase, graph, esmini, workDir: path.join(scratch, testCase.id), roadXodr, corpusDir: CORPUS });
    results.push(result);
    const committed = path.join(CORPUS, 'xosc', `${testCase.id}.xosc`);
    if ((testCase.kind ?? 'engine') !== 'engine') {
      // probes are hand-written; nothing generated to compare
    } else if (mode === 'update-xosc') {
      mkdirSync(path.dirname(committed), { recursive: true });
      if (actionsXosc) writeFileSync(committed, actionsXosc);
      else rmSync(committed, { force: true });
    } else if ((actionsXosc ?? null) !== (existsSync(committed) ? readFileSync(committed, 'utf8') : null)) {
      staleXosc += 1;
      console.error(`osc-conformance: ${testCase.id}: committed xosc differs from the current actions export`);
    }
    const flag = result.unexpected.length ? 'UNEXPECTED' : 'ok';
    console.log(`${flag.padEnd(10)} ${testCase.id.padEnd(40)} ours=${result.ours.verdict.padEnd(16)} esmini=${result.esmini.verdict.padEnd(12)} roundTrip=${result.roundTrip.verdict}`);
    for (const reason of result.unexpected) console.log(`           ↳ ${reason}`);
  }
} finally {
  if (keep) console.log(`osc-conformance: work files kept in ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

const jsonOut = argValue('--json');
const markdownOut = argValue('--markdown');
const report = { schema: 'simforge.osc-conformance-report/v1', esmini: esmini ? { version: esmini.version, sha256: esmini.sha256 } : null, results };
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
if (markdownOut) writeFileSync(markdownOut, formatReport(report));

const unexpected = results.filter((result) => result.unexpected.length > 0).length;
console.log(`osc-conformance: ${results.length} cases, ${unexpected} unexpected, ${staleXosc} stale xosc (esmini ${esmini?.version ?? 'absent'})`);
process.exit(unexpected > 0 || (mode === 'verify' && staleXosc > 0) ? 1 : 0);
