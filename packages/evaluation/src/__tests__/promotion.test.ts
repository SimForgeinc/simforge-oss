import { describe, expect, it } from 'vitest';
import { alpasimStyleScore, authoredRouteLateralM, scoreEpisode } from '../scoring.js';
import { day28Statistics, promotionHealth, type PromotionEpisode } from '../promote.js';
import { discoverPanelIds, isScreeningPanel, loadPanel, panelDigest } from '../panels.js';
import type { ResultManifest } from '../protocol/manifest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const clean = { progress: 0.4, collisionAtFault: false, offroad: false, maxLateralM: 0 };
const statistics = { bootstrapSeed: 28092026, bootstrapReplicates: 10000, confidence: 0.95, minimumCollisionReduction: 0.2, maximumCompletionLoss: 0.02, referenceRule: 'mean >= reference - 1 SE' } as const;
function episode(id: number, collision: boolean, progress = 1): PromotionEpisode {
  const score = scoreEpisode({ reset: { seed: id, t: 0, sv: [0, 0, 1, 0, 1, 0, 0, 0, 0], objs: [] }, steps: [{ step: 0, t: 0.1, sv: [progress, 0, 1, 0, 1, 0, 0, 0, progress], rw: collision ? -10 : 0, terms: [0, 0, 0], term: Number(collision), trunc: 0, miss: 0, objs: [] }], summary: null }, { decisionHz: 10, expectedRouteM: 1 });
  return { entryId: String(id), source: 'test', seed: id, pairId: String(id), mapId: 'held-out', score, runDir: '/unused', health: { healthy: true, reasons: [] }, error: null };
}

describe('alpasim-style-score, not an AlpaSim result', () => {
  it('caps progress at 80 percent without changing the driving metric', () => {
    expect(alpasimStyleScore(clean).value).toBe(0.5);
    expect(alpasimStyleScore({ ...clean, progress: 0.8 }).value).toBe(1);
    expect(alpasimStyleScore({ ...clean, progress: 1.2 }).value).toBe(1);
    expect(alpasimStyleScore({ ...clean, progress: -0.1 }).value).toBe(0);
  });
  it('the 4 m lateral boundary is inclusive and longitudinal overshoot is not lateral exit', () => {
    expect(alpasimStyleScore({ ...clean, maxLateralM: 4 - 1e-9 }).value).toBe(0.5);
    expect(alpasimStyleScore({ ...clean, maxLateralM: 4 }).value).toBe(0);
    expect(authoredRouteLateralM([[0, 0], [10, 0]], 100, 0)).toBe(0);
    expect(authoredRouteLateralM([[0, 0], [10, 0]], 5, -4)).toBe(4);
  });
  it('known hard failures force zero, while unknown safety evidence never passes', () => {
    expect(alpasimStyleScore({ ...clean, collisionAtFault: true }).value).toBe(0);
    expect(alpasimStyleScore({ ...clean, offroad: true }).value).toBe(0);
    expect(alpasimStyleScore({ ...clean, offroad: null }).value).toBeNull();
    expect(alpasimStyleScore({ ...clean, collisionAtFault: null }).value).toBeNull();
    expect(alpasimStyleScore({ ...clean, progress: null }).value).toBeNull();
    expect(alpasimStyleScore({ ...clean, maxLateralM: 4, offroad: null }).value).toBe(0);
  });
  it('front and lateral contacts fail but rear-only is not geometric fault', () => {
    const base = episode(1, true).score!;
    expect(base.drivingScore).toBeGreaterThan(0);
    for (const side of ['front', 'lateral', 'rear'] as const) {
      const trace = { reset: { seed: 1, t: 0, sv: [0, 0, 1, 0, 0, 0, 0, 0, 0], objs: [] }, steps: [{ step: 0, t: 0.1, sv: [0.4, 0, 1, 0, 0, 0, 0, 0, 0.4], rw: -10, term: 1, trunc: 0, miss: 0, objs: [], collision: { partnerId: 'other', partnerKind: 'car', side } }], summary: null };
      const score = scoreEpisode(trace, { decisionHz: 10, expectedRouteM: 1, alpasimStyle: { authoredRoute: [[0, 0], [10, 0]] } });
      expect(score['alpasim-style-score']!.hardFailures.includes('front-or-lateral-collision')).toBe(side !== 'rear');
      expect(score.drivingScore).toBeCloseTo(0.24);
    }
  });
  it('does not exempt a later front contact when the first contact in the same decision was rear-only', () => {
    const trace = { reset: null, steps: [{
      step: 0, t: 0.1, sv: [0, 0, 1, 0, 0, 0, 0, 0, 0], rw: -10, term: 1, trunc: 0, miss: 0, objs: [],
      collision: { partnerId: 'rear-car', partnerKind: 'car', side: 'rear' as const },
      events: [
        { kind: 'collision', a: 'ego', b: 'rear-car', contactSides: ['rear', 'front'] as const },
        { kind: 'collision', a: 'front-car', b: 'ego', contactSides: ['rear', 'front'] as const },
      ],
    }], summary: null };
    expect(scoreEpisode(trace, { decisionHz: 10, alpasimStyle: { authoredRoute: [[0, 0], [100, 0]], egoId: 'ego' } })['alpasim-style-score']!.hardFailures).toContain('front-or-lateral-collision');
  });
});

describe('promotion prerequisites and pre-registered statistics', () => {
  it('refuses partial, fallback, invalid and missing receipt fields before score consumption', () => {
    const health = { decisions: 10, fallbacks: { closedLoop: 0 }, invalidPlans: 0, timeouts: 0, sessions: { expected: 1, completed: 1 } };
    const manifest = { status: 'succeeded', metrics: { modelHealth: health } } as unknown as ResultManifest;
    expect(promotionHealth(manifest).healthy).toBe(true);
    for (const change of [{ fallbacks: { closedLoop: 1 } }, { invalidPlans: 1 }, { sessions: { expected: 1, completed: 0 } }, { timeouts: undefined }]) expect(promotionHealth({ ...manifest, metrics: { modelHealth: { ...health, ...change } } }).healthy).toBe(false);
    expect(promotionHealth({ ...manifest, status: 'partial' }).healthy).toBe(false);
    expect(promotionHealth(null).healthy).toBe(false);
  });
  it('does not call a zero-collision BC ceiling evidence of improvement', () => {
    const rows = Array.from({ length: 8 }, (_, i) => episode(i, false));
    expect(day28Statistics(rows, rows, statistics).status).toBe('insufficient-evidence');
    expect(day28Statistics(rows, undefined, statistics).status).toBe('insufficient-evidence');
  });
  it('keeps episode pairing independent of arrival order, and enforces completion loss', () => {
    const candidate = Array.from({ length: 8 }, (_, i) => episode(i, false));
    const baseline = candidate.map((_, i) => episode(i, true));
    const result = day28Statistics(candidate, [...baseline].reverse(), statistics);
    expect(result.status).toBe('passed');
    expect(result.pairedAbsoluteReduction95CI).toEqual([1, 1]);
    expect(day28Statistics(candidate.map((_, i) => episode(i, false, 0.98)), baseline, statistics).status).toBe('passed');
    expect(day28Statistics(candidate.map((_, i) => episode(i, false, 0.97)), baseline, statistics).status).toBe('failed');
    expect(day28Statistics(candidate, baseline.slice(1), statistics).status).toBe('insufficient-evidence');
  });
  it('loads the frozen paired canary and devpanel as exact explicit-seed grids', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const canary = await loadPanel(path.join(root, 'qualification/panels/canary8.panel.json'));
    const dev = await loadPanel(path.join(root, 'qualification/panels/devpanel32.panel.json'));
    expect(dev.panel.entries.slice(0, 8)).toEqual(canary.panel.entries);
    expect(canary.panel.entries.filter((e) => e.source === 'test').map((e) => [e.instance, e.seed])).toEqual([[0, 200], [20, 200], [40, 200], [1, 201]]);
  });
  it('discovers and loads newly authored panel ids and sizes without a code allowlist', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const original = await loadPanel(path.join(root, 'qualification/panels/canary8.panel.json'));
    const directory = await mkdtemp(path.join(tmpdir(), 'simforge-panel-discovery-'));
    try {
      const custom = {
        ...original.panel, panelId: 'local-micro4', expectedEpisodes: 4, entries: original.panel.entries.slice(0, 4),
        sources: original.panel.sources.map((source) => ({ ...source,
          manifest: path.resolve(path.dirname(original.file), source.manifest),
          episodes: path.resolve(path.dirname(original.file), source.episodes),
        })),
      };
      custom.digest = panelDigest(custom);
      const file = path.join(directory, 'local-micro4.panel.json');
      await writeFile(file, JSON.stringify(custom));
      await writeFile(path.join(directory, 'verification.json'), '{}');
      await mkdir(path.join(directory, 'not-a-file.panel.json'));
      expect(await discoverPanelIds(directory)).toEqual(['local-micro4']);
      const loaded = await loadPanel(file);
      expect(loaded.panel.entries.map((entry) => entry.id)).toEqual(custom.entries.map((entry) => entry.id));
      expect(isScreeningPanel(loaded.panel)).toBe(true);
      custom.expectedEpisodes = 6;
      custom.digest = panelDigest(custom);
      await writeFile(file, JSON.stringify(custom));
      await expect(loadPanel(file)).rejects.toThrow(/count/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['v2', 'v3'])('pins the preselection %s devpanel to all six admitted cells and explicit parent-matched controls', async (version) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const directory = path.join(root, 'qualification/panels');
    expect(await discoverPanelIds(directory)).toContain(`devpanel32-${version}`);
    const { panel } = await loadPanel(path.join(directory, `devpanel32-${version}.panel.json`));
    expect(panel.sources.map((source) => source.episodes)).toEqual([
      `../training-splits/poc-${version}/poc-${version}-test.episodes.json`,
      `../training-splits/poc-${version}/poc-${version}-control.episodes.json`,
    ]);
    expect(panel.entries.filter((entry) => entry.source === 'test').map((entry) => [entry.instance, entry.seed])).toEqual([
      [0, 200], [20, 200], [40, 200], [60, 200], [80, 200], [100, 200],
      [1, 201], [21, 201], [41, 201], [61, 201], [81, 201], [101, 201],
      [2, 202], [22, 202], [42, 202], [62, 202],
    ]);
    expect(panel.expectedEpisodes).toBe(32);
    expect(isScreeningPanel(panel)).toBe(false);
  });
});
