import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateBudgets, formatChecks } from './map-load-budget.mjs';

const budgets = { budgets: [
  { map: 'richmond-field-station', setting: 'low-no-foliage', mode: 'editor', interactiveMs: 5000, cacheReads: 40, basisTranscodes: 0 },
  { map: 'belmont-research-center', setting: 'medium', mode: 'drive', interactiveMs: 8000 },
] };
const run = (interactiveMs, cacheReads = 12, basisTranscodes = 0) => ({ interactiveMs, cacheReads, basisTranscodes });

test('time budgets bound the warm median, count budgets the warm maximum', () => {
  const evaluation = evaluateBudgets(budgets, [
    { map: 'richmond-field-station', setting: 'low-no-foliage', mode: 'editor', warm: [run(3000), run(9000), run(4000, 41)] },
  ]);
  const byField = Object.fromEntries(evaluation.checks.map((check) => [check.field, check]));
  assert.equal(byField.interactiveMs.actual, 4000); // one slow outlier does not fail the median
  assert.equal(byField.interactiveMs.ok, true);
  assert.equal(byField.cacheReads.actual, 41); // one run over the count budget does
  assert.equal(byField.cacheReads.ok, false);
  assert.equal(evaluation.ok, false);
  assert.match(formatChecks(evaluation), /FAIL richmond-field-station\/low-no-foliage\/editor\s+cacheReads/);
});

test('a surface that never became interactive fails its time budget instead of skipping it', () => {
  const evaluation = evaluateBudgets(budgets, [
    { map: 'richmond-field-station', setting: 'low-no-foliage', mode: 'editor', warm: [{ interactiveMs: null, cacheReads: 3, basisTranscodes: 0 }] },
  ]);
  const check = evaluation.checks.find((candidate) => candidate.field === 'interactiveMs');
  assert.equal(check.ok, false);
  assert.match(check.reason, /no warm run reached/);
});

test('budgets for surfaces this invocation did not measure are not evaluated', () => {
  const evaluation = evaluateBudgets(budgets, [
    { map: 'richmond-field-station', setting: 'low-no-foliage', mode: 'editor', warm: [run(1000)] },
  ]);
  assert.equal(evaluation.checks.some((check) => check.key.startsWith('belmont')), false);
  assert.equal(evaluation.ok, true);
});

test('any Basis transcode on a GPU-native tier fails its budget', () => {
  const evaluation = evaluateBudgets(budgets, [
    { map: 'richmond-field-station', setting: 'low-no-foliage', mode: 'editor', warm: [run(1000, 10, 3)] },
  ]);
  assert.equal(evaluation.checks.find((check) => check.field === 'basisTranscodes').ok, false);
});
