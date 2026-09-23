/**
 * The OpenSCENARIO conformance suite's own tests, plus the primary suite run.
 *
 * The primary check (SimForge vs the spec-derived oracle) needs no
 * third-party simulator, so it runs here on every CI run. Hand-written `xosc`
 * probes have no SimForge side; they only record esmini evidence. The esmini cross-check and trajectory round trip
 * run in `pnpm osc-conformance:verify` when esmini is installed.
 * See docs/engineering/openscenario-conformance.md.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLaneGraph } from '@simforge-oss/engine/node';
import { buildMapTopologyIndex } from '@simforge-oss/maps/topology';
import { afterAll, describe, expect, it } from 'vitest';

import type { ConformanceCase } from '../tools/osc-conformance/cases.js';
import { readEsminiCsv } from '../tools/osc-conformance/esmini-csv.js';
import { endTimes, parseEsminiLog, startTimes } from '../tools/osc-conformance/esmini-log.js';
import { evaluateActorOracle, shapeProgress } from '../tools/osc-conformance/oracle.js';
import { laneCenterY, straightRoadXodr } from '../tools/osc-conformance/road.js';
import { runCase } from '../tools/osc-conformance/run.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = path.join(REPO_ROOT, 'fixtures', 'osc-conformance');
const DOC = readFileSync(path.join(REPO_ROOT, 'docs', 'engineering', 'openscenario-conformance.md'), 'utf8');
const ADDON_DIR = path.join(REPO_ROOT, 'packages', 'native-runtime', 'native');
const haveAddon = existsSync(ADDON_DIR) && readdirSync(ADDON_DIR).some((file) => file.endsWith('.node'));
const at = (samples: ReturnType<typeof evaluateActorOracle>, t: number) => samples.find((sample) => Math.abs(sample.t - t) < 1e-9)!;

describe('spec oracle (closed-form DynamicsShape evaluation)', () => {
  it('implements the four ASAM shapes with zero end gradients where required', () => {
    expect([0, 0.25, 0.5, 1].map((tau) => shapeProgress('linear', tau))).toEqual([0, 0.25, 0.5, 1]);
    expect(shapeProgress('cubic', 0.5)).toBeCloseTo(0.5, 12);
    expect(shapeProgress('sinusoidal', 0.5)).toBeCloseTo(0.5, 12);
    const slope = (shape: 'cubic' | 'sinusoidal', tau: number) => (shapeProgress(shape, tau + 1e-6) - shapeProgress(shape, tau)) / 1e-6;
    for (const shape of ['cubic', 'sinusoidal'] as const) {
      expect(slope(shape, 0)).toBeCloseTo(0, 4);
      expect(slope(shape, 1 - 1e-6)).toBeCloseTo(0, 4);
    }
    expect(shapeProgress('step', 0)).toBe(0);
    expect(shapeProgress('step', 1e-9)).toBe(1);
  });

  it('integrates a linear ramp exactly', () => {
    const samples = evaluateActorOracle({ x0: 50, y0: 0, v0: 20, longitudinal: [{ t0: 1, to: 10, shape: 'linear', durationS: 2.5 }] }, 5);
    // x(3.5) = 50 + 20·1 + (20+10)/2·2.5
    expect(at(samples, 3.5).x).toBeCloseTo(107.5, 6);
    expect(at(samples, 5).x).toBeCloseTo(122.5, 6);
    expect(at(samples, 2).speedMps).toBeCloseTo(16, 9);
  });

  it('samples a step change pre-action at the trigger tick (decision D-01)', () => {
    const samples = evaluateActorOracle({ x0: 0, y0: 0, v0: 20, longitudinal: [{ t0: 1, to: 10, shape: 'step' }] }, 2);
    expect(at(samples, 1).speedMps).toBe(20);
    expect(at(samples, 1.02).speedMps).toBe(10);
    expect(at(samples, 2).x).toBeCloseTo(30, 1);
  });

  it('evaluates a distance-dimension shape as a function of travelled distance (decision D-02)', () => {
    const samples = evaluateActorOracle({ x0: 0, y0: 0, v0: 20, longitudinal: [{ t0: 0, to: 10, shape: 'linear', distanceM: 30 }] }, 3);
    // v(s) = 20 − s/3 → s(t) = 60(1 − e^{−t/3}); 30 m at t = 3 ln 2.
    expect(at(samples, 2).x).toBeCloseTo(60 * (1 - Math.exp(-2 / 3)), 4);
    expect(at(samples, 2.08).speedMps).toBeCloseTo(10, 1);
  });

  it('spends part of the speed on lateral motion (speed is the velocity vector length)', () => {
    const samples = evaluateActorOracle({ x0: 0, y0: -5.25, v0: 20, lateral: [{ t0: 0, toY: -1.75, shape: 'sinusoidal', durationS: 3 }] }, 3);
    expect(at(samples, 3).y).toBeCloseTo(-1.75, 9);
    expect(at(samples, 3).x).toBeLessThan(60);
    expect(at(samples, 3).x).toBeGreaterThan(59.8);
  });
});

describe('esmini observables', () => {
  it('parses storyboard transitions from the text log', () => {
    const log = [
      '[0.000] [info] ev standbyState -> startTransition -> runningState',
      '[1.000] [info] ev runningState -> endTransition -> standbyState',
      '[1.020] [info] ev standbyState -> startTransition -> runningState',
      '[3.480] [info] ev runningState -> stopTransition -> completeState',
      '[3.480] [info] noise that is not a transition',
    ].join('\n');
    const transitions = parseEsminiLog(log);
    expect(startTimes(transitions, 'ev')).toEqual([0, 1.02]);
    expect(endTimes(transitions, 'ev').map((end) => [end.t, end.transition])).toEqual([[1, 'endTransition'], [3.48, 'stopTransition']]);
  });

  it('reads CSV rows whose entity groups shrink after a deletion', () => {
    const fields = ['Entity_Name [-]', 'Entity_ID [-]', 'Current_Speed [m/s]', 'World_Position_X [m]', 'World_Position_Y [m]', 'World_Heading_Angle [rad]'];
    const header = ['Index [-]', 'TimeStamp [s]', ...fields.map((f) => `#1 ${f}`), ...fields.map((f) => `#2 ${f}`)].join(', ');
    const csv = [
      'esmini GIT TAG: v3.6.0',
      header,
      '0, 0.000, a, 0, 20, 50, -5.25, 0, b, 1, 20, 50, -8.75, 0, ',
      '1, 0.020, b, 1, 20, 50.4, -8.75, 0, ',
    ].join('\n');
    const read = readEsminiCsv(csv);
    expect(read.get('a')).toHaveLength(1);
    expect(read.get('b')!.map((sample) => sample.x)).toEqual([50, 50.4]);
  });
});

describe('conformance road', () => {
  it('places lane centres where the oracles assume them', () => {
    expect([1, -1, -2, -3].map((lane) => laneCenterY(lane))).toEqual([1.75, -1.75, -5.25, -8.75]);
    const topology = buildMapTopologyIndex({ mapName: 'road', xodr: straightRoadXodr().replace(/>\s*</g, '>\n<') });
    const lane = topology.lanes['1:0:-2']!;
    expect(lane.polyline[0]).toEqual({ x: 0, y: -5.25 });
  });
});

describe('conformance corpus (primary suite: SimForge vs the ASAM-derived oracle)', () => {
  const cases = readdirSync(path.join(CORPUS, 'cases'))
    .filter((file) => file.endsWith('.case.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(CORPUS, 'cases', file), 'utf8')) as ConformanceCase);
  const roadXodr = straightRoadXodr();
  const graph = haveAddon
    ? buildLaneGraph(buildMapTopologyIndex({ mapName: 'osc-conformance-straight', xodr: roadXodr.replace(/>\s*</g, '>\n<') }) as never)
    : (null as never);
  const scratch = mkdtempSync(path.join(tmpdir(), 'simforge-osc-conformance-test-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('has cited clauses, a derivation and documented findings/decisions for every case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const testCase of cases) {
      expect(testCase.oracle.clauses.length, testCase.id).toBeGreaterThan(0);
      expect(testCase.oracle.derivation.length, testCase.id).toBeGreaterThan(20);
      for (const finding of (testCase.expect.finding ?? '').split(',').filter(Boolean)) {
        expect(DOC, `${testCase.id} cites ${finding}`).toContain(`| ${finding} |`);
      }
      for (const decision of testCase.oracle.decisions ?? []) {
        expect(DOC, `${testCase.id} cites ${decision}`).toContain(`| ${decision} |`);
      }
    }
  });

  it.skipIf(!haveAddon).each(cases.map((testCase) => [testCase.id, testCase] as const))('%s', (_id, testCase) => {
    const { result } = runCase({ testCase, graph, esmini: null, workDir: path.join(scratch, testCase.id), roadXodr, corpusDir: CORPUS });
    expect(result.unexpected).toEqual([]);
  });
});
