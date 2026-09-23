/**
 * Map-load benchmark budgets: pure evaluation, shared by the runner and its
 * tests. A budget file (config/bench/map-load-budgets.json) lists, per map,
 * rendering setting and surface, the warm-load ceilings a change may not
 * exceed. Time budgets are judged on the warm median; count budgets (reads,
 * transcodes, GPU readbacks, network requests) on the warm maximum, because a
 * structural regression shows up in every run.
 */

import { median } from './common.mjs';

/** Fields a budget entry may bound, and how each is aggregated over warm runs. */
export const BUDGET_FIELDS = {
  firstFrameMs: 'median',
  usableMs: 'median',
  interactiveMs: 'median',
  fullMs: 'median',
  cacheReads: 'max',
  mapNetworkRequests: 'max',
  basisTranscodes: 'max',
  albedoReadbacks: 'max',
  mainThreadLongTaskMs: 'median',
};

export function budgetKey({ map, setting, mode }) {
  return `${map}/${setting}/${mode}`;
}

/**
 * @param {{ budgets: Array<Record<string, unknown>> }} budgetFile
 * @param {Array<{ map: string, setting: string, mode: string, warm: Array<Record<string, number|null>> }>} results
 * @returns {{ ok: boolean, checks: Array<{ key: string, field: string, limit: number, actual: number|null, ok: boolean, reason?: string }> }}
 */
export function evaluateBudgets(budgetFile, results) {
  const checks = [];
  for (const budget of budgetFile.budgets ?? []) {
    const key = budgetKey(budget);
    const result = results.find((candidate) => budgetKey(candidate) === key);
    if (!result) continue; // not measured in this invocation (filtered by --maps/--settings/--modes)
    const warm = result.warm ?? [];
    for (const [field, aggregate] of Object.entries(BUDGET_FIELDS)) {
      const limit = budget[field];
      if (typeof limit !== 'number') continue;
      const values = warm.map((run) => run[field]).filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (values.length === 0) {
        // A run that never reached the stage is a failure, not a skipped check.
        checks.push({ key, field, limit, actual: null, ok: false, reason: `no warm run reached ${field}` });
        continue;
      }
      const actual = aggregate === 'max' ? Math.max(...values) : median(values);
      checks.push({ key, field, limit, actual, ok: actual <= limit });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export function formatChecks(evaluation) {
  const lines = [];
  for (const check of evaluation.checks) {
    const actual = check.actual === null ? 'n/a' : Math.round(check.actual);
    lines.push(`${check.ok ? 'ok  ' : 'FAIL'} ${check.key.padEnd(52)} ${check.field.padEnd(20)} ${String(actual).padStart(8)} <= ${check.limit}${check.reason ? ` (${check.reason})` : ''}`);
  }
  return lines.join('\n');
}
