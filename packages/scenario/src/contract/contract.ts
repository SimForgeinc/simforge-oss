/**
 * The scenario document contract lock and the `scenarioVersion` bump rule.
 *
 * `packages/scenario/scenario-contract.lock.json` records, for the current
 * `scenarioVersion`:
 *
 * - the canonical JSON-schema snapshot of the template (annotations stripped);
 * - {@link SCENARIO_ABSENT_FIELD_SEMANTICS}, the "absent means X" rules that
 *   live in code rather than in the schema;
 * - the upgrader steps.
 *
 * `pnpm scenario:contract:check` (`scripts/scenario-contract.ts`) regenerates
 * that record from the code and compares it with the committed lock (and, in
 * CI, with the lock at the merge base) through {@link scenarioContractViolations}.
 * The rule itself is described in `src/upgrade/chain.ts`.
 */

import { buildTemplateJsonSchema } from '../json-schema-v2.js';
import { SCENARIO_ABSENT_FIELD_SEMANTICS, type AbsentFieldSemantic } from '../upgrade/absent-field-semantics.js';
import { CURRENT_SCENARIO_VERSION, FIRST_TEMPLATE_VERSION, SCENARIO_UPGRADE_STEPS } from '../upgrade/chain.js';
import { diffJsonSchemas, normalizeJsonSchema, type JsonSchema, type SchemaChange } from './schema-diff.js';

export const SCENARIO_CONTRACT_LOCK_FORMAT = 'simforge.scenario-contract-lock/v1';
/** Repository-relative path of the committed lock. */
export const SCENARIO_CONTRACT_LOCK_PATH = 'packages/scenario/scenario-contract.lock.json';
/** Where the Rust `SCENARIO_TEMPLATE_VERSION` literal lives. */
export const RUST_TEMPLATE_VERSION_SOURCE = 'native/crates/simforge-compiler/src/template.rs';
/** Where the Rust `TEMPLATE_UPGRADE_STEPS` table lives. */
export const RUST_TEMPLATE_STEPS_SOURCE = 'native/crates/simforge-compiler/src/template_upgrade.rs';
/** The command that refreshes the lock. */
export const SCENARIO_CONTRACT_WRITE_COMMAND = 'pnpm scenario:contract:check --write';

export interface ScenarioContractStep {
  readonly from: number;
  readonly to: number;
  readonly description: string;
}

/** The committed lock, and the record regenerated from code. */
export interface ScenarioContractLock {
  readonly format: typeof SCENARIO_CONTRACT_LOCK_FORMAT;
  readonly scenarioVersion: number;
  readonly upgradeSteps: readonly ScenarioContractStep[];
  readonly absentFieldSemantics: readonly AbsentFieldSemantic[];
  readonly templateSchema: JsonSchema;
}

/** What the Rust sources declare. */
export interface RustTemplateContract {
  readonly scenarioTemplateVersion: number;
  readonly steps: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

/** Regenerate the contract record from this build's code. */
export function buildScenarioContract(): ScenarioContractLock {
  return {
    format: SCENARIO_CONTRACT_LOCK_FORMAT,
    scenarioVersion: CURRENT_SCENARIO_VERSION,
    upgradeSteps: SCENARIO_UPGRADE_STEPS.map(({ from, to, description }) => ({ from, to, description })),
    absentFieldSemantics: SCENARIO_ABSENT_FIELD_SEMANTICS.map((entry) => ({ ...entry, sources: [...entry.sources] })),
    templateSchema: normalizeJsonSchema(buildTemplateJsonSchema()),
  };
}

/** The lock's file text: two-space JSON, trailing newline. */
export function serializeScenarioContract(lock: ScenarioContractLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Parse a committed lock, refusing anything that is not one. */
export function parseScenarioContractLock(text: string, origin: string): ScenarioContractLock {
  const value = JSON.parse(text) as Partial<ScenarioContractLock>;
  if (
    value.format !== SCENARIO_CONTRACT_LOCK_FORMAT ||
    typeof value.scenarioVersion !== 'number' ||
    !Array.isArray(value.upgradeSteps) ||
    !Array.isArray(value.absentFieldSemantics) ||
    value.templateSchema === undefined
  ) {
    throw new Error(`${origin} is not a ${SCENARIO_CONTRACT_LOCK_FORMAT} file`);
  }
  return value as ScenarioContractLock;
}

function stripRustComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Read `SCENARIO_TEMPLATE_VERSION` and the `TEMPLATE_UPGRADE_STEPS` table out
 * of the Rust sources. The Rust test `step_table_is_in_the_form_ci_parses`
 * keeps the table in the literal `TemplateUpgradeStep { from: N, to: M, .. }`
 * form this reads.
 */
export function parseRustTemplateContract(templateRs: string, templateUpgradeRs: string): RustTemplateContract {
  const version = /pub const SCENARIO_TEMPLATE_VERSION: u32 = (\d+);/.exec(templateRs);
  if (!version) throw new Error(`${RUST_TEMPLATE_VERSION_SOURCE}: no \`pub const SCENARIO_TEMPLATE_VERSION: u32 = N;\` literal`);
  const source = stripRustComments(templateUpgradeRs);
  const open = /pub const TEMPLATE_UPGRADE_STEPS: &\[TemplateUpgradeStep\] = &\[/.exec(source);
  if (!open) throw new Error(`${RUST_TEMPLATE_STEPS_SOURCE}: no \`pub const TEMPLATE_UPGRADE_STEPS: &[TemplateUpgradeStep] = &[\` table`);
  const start = open.index + open[0].length;
  const end = source.indexOf('];', start);
  if (end === -1) throw new Error(`${RUST_TEMPLATE_STEPS_SOURCE}: TEMPLATE_UPGRADE_STEPS is not closed with \`];\``);
  const table = source.slice(start, end);
  const steps: Array<{ from: number; to: number }> = [];
  const entry = /TemplateUpgradeStep\s*\{\s*from:\s*(\d+)\s*,\s*to:\s*(\d+)\s*,/g;
  for (let match = entry.exec(table); match; match = entry.exec(table)) {
    steps.push({ from: Number(match[1]), to: Number(match[2]) });
  }
  const literals = table.match(/TemplateUpgradeStep\s*\{/g)?.length ?? 0;
  if (literals !== steps.length) {
    throw new Error(`${RUST_TEMPLATE_STEPS_SOURCE}: ${literals} TemplateUpgradeStep entries, but only ${steps.length} in the \`from: N, to: M,\` form this check reads`);
  }
  return { scenarioTemplateVersion: Number(version[1]), steps };
}

/** Outcome of {@link scenarioContractViolations}. */
export interface ScenarioContractReport {
  /** Rule violations: fixed only by a code change (a bump, an upgrader, parity). */
  readonly violations: readonly string[];
  /** The lock is out of date but nothing needs a bump: refresh it with `--write`. */
  readonly stale: readonly string[];
  /** Every schema difference against the lock, classified. */
  readonly schemaChanges: { readonly additive: readonly SchemaChange[]; readonly breaking: readonly SchemaChange[] };
}

const stepKey = (step: { from: number; to: number }): string => `v${step.from}->v${step.to}`;

/** The upgrader chain's own shape, and its Rust parity. Independent of any lock. */
function chainViolations(current: ScenarioContractLock, rust: RustTemplateContract): string[] {
  const violations: string[] = [];
  const steps = [...current.upgradeSteps].sort((a, b) => a.from - b.from);
  for (const step of steps) {
    if (step.to !== step.from + 1) violations.push(`upgrade step ${stepKey(step)} must go up by exactly one version`);
    if (step.from >= current.scenarioVersion) {
      violations.push(`upgrade step ${stepKey(step)} starts at or above the current scenarioVersion ${current.scenarioVersion}`);
    }
  }
  const first = steps[0]?.from ?? current.scenarioVersion;
  for (let version = first; version < current.scenarioVersion; version += 1) {
    const count = steps.filter((step) => step.from === version).length;
    if (count !== 1) {
      violations.push(`the TypeScript chain needs exactly one upgrade step from v${version} (found ${count}); packages/scenario/src/upgrade/chain.ts`);
    }
  }
  if (rust.scenarioTemplateVersion !== current.scenarioVersion) {
    violations.push(
      `Rust SCENARIO_TEMPLATE_VERSION is ${rust.scenarioTemplateVersion} (${RUST_TEMPLATE_VERSION_SOURCE}) but the TypeScript scenarioVersion is ${current.scenarioVersion}`,
    );
  }
  const tsTemplateSteps = steps.filter((step) => step.from >= FIRST_TEMPLATE_VERSION).map(stepKey);
  const rustSteps = [...rust.steps].sort((a, b) => a.from - b.from).map(stepKey);
  if (tsTemplateSteps.join(',') !== rustSteps.join(',')) {
    violations.push(
      `Rust TEMPLATE_UPGRADE_STEPS (${RUST_TEMPLATE_STEPS_SOURCE}) lists [${rustSteps.join(', ')}] but the TypeScript chain has template steps [${tsTemplateSteps.join(', ')}]; every template step (from v${FIRST_TEMPLATE_VERSION} on) must exist in both`,
    );
  }
  return violations;
}

const SEMANTIC_KEYS = ['field', 'when', 'meaning'] as const;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/**
 * The bump rule. `locked` is the committed lock (or the lock at the merge
 * base); `current` is {@link buildScenarioContract}; `rust` is
 * {@link parseRustTemplateContract}.
 *
 * Violations:
 * - `scenarioVersion` went down;
 * - a non-additive template schema change without a bump;
 * - a changed or removed absent-field meaning without a bump;
 * - a bump without a TypeScript upgrader step from each skipped version;
 * - a broken chain, or Rust declaring a different version or template steps.
 *
 * Stale (refresh with `--write`): additive schema changes, new registry
 * entries, prose-only registry edits, and the lock of a legitimate bump.
 */
export function scenarioContractViolations(input: {
  readonly locked: ScenarioContractLock | null;
  readonly current: ScenarioContractLock;
  readonly rust: RustTemplateContract;
}): ScenarioContractReport {
  const { locked, current, rust } = input;
  const violations = chainViolations(current, rust);
  const stale: string[] = [];
  if (!locked) {
    stale.push(`no ${SCENARIO_CONTRACT_LOCK_PATH}; create it`);
    return { violations, stale, schemaChanges: { additive: [], breaking: [] } };
  }
  const from = locked.scenarioVersion;
  const to = current.scenarioVersion;
  const bumped = to > from;
  const bumpAdvice = `bump SCENARIO_TEMPLATE_VERSION (packages/scenario/src/schema/v2/template.ts and ${RUST_TEMPLATE_VERSION_SOURCE}) to ${from + 1} and add a v${from} -> v${from + 1} upgrader to SCENARIO_UPGRADE_STEPS (packages/scenario/src/upgrade/chain.ts) and TEMPLATE_UPGRADE_STEPS (${RUST_TEMPLATE_STEPS_SOURCE})`;

  if (to < from) violations.push(`scenarioVersion went down: v${from} -> v${to}`);
  if (bumped) {
    for (let version = from; version < to; version += 1) {
      if (!current.upgradeSteps.some((step) => step.from === version && step.to === version + 1)) {
        violations.push(
          `scenarioVersion was bumped v${from} -> v${to} without a TypeScript upgrader step from v${version}; add { from: ${version}, to: ${version + 1}, ... } to SCENARIO_UPGRADE_STEPS (packages/scenario/src/upgrade/chain.ts)`,
        );
      }
    }
    stale.push(`the lock records scenarioVersion ${from}; this change bumps it to ${to}`);
  }

  const schemaChanges = diffJsonSchemas(locked.templateSchema, current.templateSchema, {
    ignoreRootProperties: ['scenarioVersion'],
  });
  if (!bumped) {
    for (const change of schemaChanges.breaking) {
      violations.push(
        `template schema, ${change.path}: ${change.change}. This is not additive and needs a scenarioVersion bump: ${bumpAdvice}`,
      );
    }
  }
  for (const change of schemaChanges.additive) {
    stale.push(`additive template schema change, ${change.path}: ${change.change}`);
  }

  const currentById = new Map(current.absentFieldSemantics.map((entry) => [entry.id, entry]));
  const lockedById = new Map(locked.absentFieldSemantics.map((entry) => [entry.id, entry]));
  for (const [id, before] of lockedById) {
    const after = currentById.get(id);
    if (!after) {
      if (!bumped) violations.push(`absent-field semantic "${id}" (${before.field}) was removed without a scenarioVersion bump: ${bumpAdvice}`);
      continue;
    }
    const changed = SEMANTIC_KEYS.filter((key) => stable(before[key]) !== stable(after[key]));
    if (changed.length > 0 && !bumped) {
      violations.push(
        `absent-field semantic "${id}" changed ${changed.map((key) => `${key} ${stable(before[key])} -> ${stable(after[key])}`).join('; ')} without a scenarioVersion bump: what an absent ${before.field} means is part of every stored document. ${bumpAdvice}`,
      );
    } else if (stable(before) !== stable(after)) {
      stale.push(`absent-field semantic "${id}": ${changed.length > 0 ? 'meaning changed with the bump' : 'note or sources edited'}`);
    }
  }
  for (const id of currentById.keys()) {
    if (!lockedById.has(id)) stale.push(`new absent-field semantic "${id}"`);
  }
  if (stable(locked.upgradeSteps) !== stable(current.upgradeSteps) && !bumped) {
    stale.push('upgrade step descriptions changed');
  }
  if (stale.length === 0 && violations.length === 0 && serializeScenarioContract(locked) !== serializeScenarioContract(current)) {
    stale.push('the lock differs from the contract generated from code');
  }
  return { violations, stale, schemaChanges };
}
