import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as workerControl from '../worker-control.js';
import {
  buildWorkerOutputContractSnapshot,
  controlFeatureConstants,
  schemaKeyPaths,
  workerOutputContractViolations,
  type WorkerOutputContractSnapshot,
} from './worker-output-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const snapshotPath = path.join(packageRoot, 'contract/worker-output-contract.json');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as WorkerOutputContractSnapshot;
const features = controlFeatureConstants(workerControl);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(directory);
  return files;
}

describe('worker output contract (server N accepts worker N-1, worker N works with server N-1)', () => {
  it('has no new ungated output key, no removed baseline key and no new required route', () => {
    const violations = workerOutputContractViolations(snapshot, features);
    expect(violations.map((violation) => `[${violation.rule}] ${violation.message}`), 'worker output contract violations').toEqual([]);
  });

  it('keeps the frozen snapshot current', () => {
    const expected = buildWorkerOutputContractSnapshot(features, snapshot);
    expect(snapshot, 'packages/render/contract/worker-output-contract.json is stale: run `pnpm --filter @simforge-oss/render contract:write` and commit it').toEqual(expected);
  });

  it('gates every control feature in worker source, never only in the contract', () => {
    // A feature constant nobody reads means its keys are written unconditionally
    // (or never). Each one must be checked where the output is produced.
    const producers = [...sourceFiles(path.join(packageRoot, 'src')), ...sourceFiles(path.join(repoRoot, 'services/render-worker/src'))]
      .filter((file) => !file.endsWith(`${path.sep}worker-control.ts`) && !file.includes(`${path.sep}contract${path.sep}`));
    const text = producers.map((file) => readFileSync(file, 'utf8')).join('\n');
    const ungated = Object.keys(features).filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
    expect(ungated, 'each CONTROL_FEATURE_* must be checked (context.controlFeatures.has(...)) where its output keys are written').toEqual([]);
  });

  it('is offered by the control plane', () => {
    // The Studio control plane lists CONTROL_FEATURES_V1 on leases of workers that
    // registered `labels.controlFeatures = "v1"`; a feature outside that list is never offered.
    const store = path.join(repoRoot, 'studio/app/lib/scenario/render-worker-control-store.ts');
    let source: string;
    try { source = readFileSync(store, 'utf8'); } catch { return; }
    expect(source, 'claimResponseV2 must send [...CONTROL_FEATURES_V1] to a worker with labels.controlFeatures = "v1"').toMatch(/controlFeatures:\s*\[\.\.\.CONTROL_FEATURES_V1\]/);
  });

  it('walks nested, array, record and union keys', () => {
    const keys = schemaKeyPaths(workerControl.LeaseProgressRequestSchema);
    expect(keys).toContain('records[].event');
    expect(keys).toContain('records[].identity.role');
    expect(schemaKeyPaths(workerControl.WorkerRegisterRequestSchema)).toContain('engine.limits.maxWidth');
  });
});
