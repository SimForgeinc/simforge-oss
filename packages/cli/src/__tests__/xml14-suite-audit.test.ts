import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuditAssetError,
  auditExpectationMismatches,
  auditGatePassed,
  auditXml14Instance,
  loadProductionAuditMap,
  summarizeAuditResults,
} from '../tools/xml14-suite-audit.js';

const temporary: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function assetRoot(stale = false): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xml14-audit-assets-'));
  temporary.push(root);
  const mapRoot = path.join(root, 'fixture-map');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(mapRoot);
  const xodr = Buffer.from('<OpenDRIVE/>');
  const digest = createHash('sha256').update(xodr).digest('hex');
  await writeFile(path.join(mapRoot, 'map.xodr'), xodr);
  await writeFile(path.join(mapRoot, 'topology-index.json.gz'), gzipSync(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    mapName: 'fixture-map',
    source: { xodrSha256: stale ? 'stale' : digest },
    lanes: {}, gates: [], junctions: {},
  }))));
  return root;
}

async function instanceFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xml14-audit-instance-'));
  temporary.push(root);
  const file = path.join(root, 'scenario.instance.json');
  await writeFile(file, JSON.stringify({
    kind: 'scenario-instance', version: 1,
    manifest: { instanceId: 'fixture#0', replayKey: { mapId: 'fixture-map', engineGraphDigest: 'fixture-digest' } },
    input: {
      schemaVersion: 1, mapId: 'fixture-map', clipSeconds: 20, warmupSeconds: 0,
      physics: { mode: 'dynamic-v1' },
      actors: [{
        id: 'ego', kind: 'vehicle', dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] } },
      }],
      props: [], interactions: [], occlusionPairs: [], signalPrograms: [],
    },
  }));
  return file;
}

describe('production OpenSCENARIO suite assets', () => {
  it('loads a digest-matched XODR/topology pair', async () => {
    const root = await assetRoot();
    const loaded = await loadProductionAuditMap('fixture-map', root);
    expect(loaded.graph.digest).toBe(loaded.xodrSha256);
    expect(loaded.graph.laneIds).toEqual([]);
  });

  it('rejects stale and missing production assets distinctly', async () => {
    await expect(loadProductionAuditMap('fixture-map', await assetRoot(true)))
      .rejects.toMatchObject({ name: 'AuditAssetError', code: 'asset-stale' });
    await expect(loadProductionAuditMap('missing-map', await assetRoot()))
      .rejects.toMatchObject({ name: 'AuditAssetError', code: 'asset-missing' });
  });

  it('reports asset-unavailable separately and blocks the hard gate', async () => {
    const result = await auditXml14Instance(await instanceFile(), '/unused/official.xsd', async () => {
      throw new AuditAssetError('asset-missing', 'production topology is unavailable');
    });
    expect(result).toMatchObject({ verdict: 'asset-blocked', assetCode: 'asset-missing' });
    const results = [
      { id: 'valid', verdict: 'xsd-validated', warningCodeCounts: { known_warning: 1 } },
      { id: 'unsupported', verdict: 'unsupported-fail-closed', issueCodeCounts: { known: 1 } },
      result,
    ] as const;
    const baseline = {
      valid: { verdict: 'xsd-validated' as const, warningCodeCounts: { known_warning: 1 } },
      unsupported: { verdict: 'unsupported-fail-closed' as const, issueCodeCounts: { known: 1 } },
      'fixture#0': { verdict: 'xsd-validated' as const, warningCodeCounts: {} },
    };
    const counts = summarizeAuditResults(results, baseline);
    expect(counts).toEqual({ total: 3, xsdValidated: 1, unsupportedFailClosed: 1, assetBlocked: 1, unexpectedFailures: 0, expectationMismatches: 1 });
    expect(auditGatePassed(counts)).toBe(false);
    const passing = summarizeAuditResults(results.slice(0, 2), { valid: baseline.valid, unsupported: baseline.unsupported });
    expect(auditGatePassed(passing)).toBe(true);
  });

  it('blocks an instance whose replay key does not match production topology', async () => {
    const production = await loadProductionAuditMap('fixture-map', await assetRoot());
    const result = await auditXml14Instance(await instanceFile(), '/unused/official.xsd', async () => production);
    expect(result).toMatchObject({
      id: 'fixture#0', mapId: 'fixture-map', verdict: 'asset-blocked', assetCode: 'instance-topology-stale',
    });
  });

  it('fails support loss, new scenarios, and changed unsupported issue counts', () => {
    const expectations = {
      supported: { verdict: 'xsd-validated' as const, warningCodeCounts: { known_warning: 1 } },
      blocked: { verdict: 'unsupported-fail-closed' as const, issueCodeCounts: { known_issue: 1 } },
    };
    const mismatches = auditExpectationMismatches([
      { id: 'supported', verdict: 'unsupported-fail-closed', issueCodeCounts: { regression: 1 } },
      { id: 'blocked', verdict: 'unsupported-fail-closed', issueCodeCounts: { known_issue: 2 } },
      { id: 'new-scenario', verdict: 'xsd-validated' },
    ], expectations);
    expect(mismatches).toEqual([
      { id: 'blocked', message: 'expected issue counts {"known_issue":1}, received {"known_issue":2}' },
      { id: 'new-scenario', message: 'scenario has no explicit support baseline; actual xsd-validated' },
      { id: 'supported', message: 'expected xsd-validated, received unsupported-fail-closed' },
    ]);
  });

  it('fails when a supported scenario warning code or count drifts', () => {
    const expectations = {
      supported: { verdict: 'xsd-validated' as const, warningCodeCounts: { known_warning: 2 } },
    };
    expect(auditExpectationMismatches([
      { id: 'supported', verdict: 'xsd-validated', warningCodeCounts: { known_warning: 1, new_warning: 1 } },
    ], expectations)).toEqual([{
      id: 'supported',
      message: 'expected warning counts {"known_warning":2}, received {"known_warning":1,"new_warning":1}',
    }]);
  });
});
