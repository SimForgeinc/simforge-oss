/**
 * The scenarioVersion bump rule: the JSON-schema diff classifier (additive vs
 * breaking), the rule itself, and the Rust-source parser CI relies on.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RUST_TEMPLATE_STEPS_SOURCE,
  RUST_TEMPLATE_VERSION_SOURCE,
  SCENARIO_CONTRACT_LOCK_PATH,
  buildScenarioContract,
  parseRustTemplateContract,
  parseScenarioContractLock,
  scenarioContractViolations,
  serializeScenarioContract,
  type RustTemplateContract,
  type ScenarioContractLock,
} from '../contract/contract.js';
import { diffJsonSchemas, normalizeJsonSchema, type JsonSchema } from '../contract/schema-diff.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const object = (properties: Record<string, JsonSchema>, required: string[] = [], extra: Record<string, unknown> = {}): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
});

function classify(before: JsonSchema, after: JsonSchema) {
  const diff = diffJsonSchemas(normalizeJsonSchema(before), normalizeJsonSchema(after));
  return {
    additive: diff.additive.map((c) => `${c.path}: ${c.change}`),
    breaking: diff.breaking.map((c) => `${c.path}: ${c.change}`),
  };
}

describe('JSON-schema diff classifier', () => {
  const base = object({ name: { type: 'string', maxLength: 10 }, kind: { type: 'string', enum: ['a', 'b'] } }, ['name']);

  it('finds nothing between equal schemas, and ignores annotations', () => {
    expect(classify(base, base)).toEqual({ additive: [], breaking: [] });
    const annotated = object(
      { name: { type: 'string', maxLength: 10, description: 'new words' }, kind: { type: 'string', enum: ['b', 'a'], title: 'Kind' } },
      ['name'],
      { description: 'changed prose', $comment: 'x' },
    );
    expect(classify(base, annotated)).toEqual({ additive: [], breaking: [] });
  });

  it('keeps a property that happens to be named like an annotation', () => {
    const schema = normalizeJsonSchema(object({ description: { type: 'string' } }));
    expect((schema as { properties: Record<string, unknown> }).properties).toHaveProperty('description');
  });

  it('classifies a new optional property as additive, a new required one as breaking', () => {
    const optional = object({ ...(base as { properties: Record<string, JsonSchema> }).properties, extra: { type: 'number' } }, ['name']);
    expect(classify(base, optional)).toEqual({ additive: ['extra: new optional property'], breaking: [] });
    const required = object({ ...(base as { properties: Record<string, JsonSchema> }).properties, extra: { type: 'number' } }, ['name', 'extra']);
    expect(classify(base, required).breaking).toEqual(['extra: new required property']);
  });

  it('classifies removed/renamed properties and required-ness changes as breaking', () => {
    const renamed = object({ title: { type: 'string', maxLength: 10 }, kind: { type: 'string', enum: ['a', 'b'] } }, ['title']);
    const result = classify(base, renamed);
    expect(result.breaking).toContain('name: property removed or renamed');
    expect(result.breaking).toContain('title: new required property');
    const optionalName = object((base as { properties: Record<string, JsonSchema> }).properties, []);
    expect(classify(base, optionalName).breaking).toEqual([
      'name: required property became optional (its absence now needs a declared meaning)',
    ]);
    const requiredKind = object((base as { properties: Record<string, JsonSchema> }).properties, ['name', 'kind']);
    expect(classify(base, requiredKind).breaking).toEqual(['kind: optional property became required']);
  });

  it('classifies type changes: widening is additive, anything else breaking', () => {
    expect(classify({ type: 'string' }, { type: ['string', 'number'] }).additive).toHaveLength(1);
    expect(classify({ type: 'string' }, { type: 'number' }).breaking).toEqual(['<root>: type changed ["string"] -> ["number"]']);
  });

  it('classifies enums: widened additive, narrowed breaking, const -> superset enum additive', () => {
    expect(classify({ enum: ['a', 'b'] }, { enum: ['a', 'b', 'c'] })).toEqual({ additive: ['<root>: enum widened: added "c"'], breaking: [] });
    expect(classify({ enum: ['a', 'b'] }, { enum: ['a'] }).breaking).toEqual(['<root>: enum narrowed: removed "b"']);
    expect(classify({ const: 'a' }, { enum: ['a', 'z'] }).additive).toHaveLength(1);
    expect(classify({ const: 2 }, { const: 3 }).breaking).toHaveLength(1);
  });

  it('classifies bounds by direction', () => {
    expect(classify({ type: 'array', maxItems: 64 }, { type: 'array', maxItems: 128 }).additive).toHaveLength(1);
    expect(classify({ type: 'array', maxItems: 64 }, { type: 'array', maxItems: 32 }).breaking).toEqual(['<root>: maxItems 64 -> 32 (narrowed)']);
    expect(classify({ type: 'number', minimum: 0 }, { type: 'number', minimum: 1 }).breaking).toHaveLength(1);
    expect(classify({ type: 'number', minimum: 0 }, { type: 'number' }).additive).toHaveLength(1);
    expect(classify({ type: 'number' }, { type: 'number', maximum: 5 }).breaking).toEqual(['<root>: new maximum 5 (narrowed)']);
    expect(classify({ type: 'string', pattern: '^a' }, { type: 'string' }).additive).toHaveLength(1);
    expect(classify({ type: 'string' }, { type: 'string', pattern: '^a' }).breaking).toHaveLength(1);
  });

  it('treats any default change as breaking: an absent field would mean something else', () => {
    const before = object({ clipSeconds: { type: 'number', default: 20 } });
    expect(classify(before, object({ clipSeconds: { type: 'number', default: 30 } })).breaking).toEqual([
      'clipSeconds: default changed: 20 -> 30 (an absent field now means something else)',
    ]);
    expect(classify(object({ x: { type: 'number' } }), object({ x: { type: 'number', default: 1 } })).breaking).toHaveLength(1);
  });

  it('matches union alternatives by discriminator: added additive, removed breaking, reorder nothing', () => {
    const speed = object({ verb: { type: 'string', const: 'speed' }, v: { type: 'number' } }, ['verb']);
    const gap = object({ verb: { type: 'string', const: 'gap' }, g: { type: 'number' } }, ['verb']);
    const exist = object({ verb: { type: 'string', const: 'exist' } }, ['verb']);
    expect(classify({ anyOf: [speed, gap] }, { anyOf: [gap, speed] })).toEqual({ additive: [], breaking: [] });
    expect(classify({ anyOf: [speed, gap] }, { anyOf: [speed, exist, gap] }).additive).toEqual([
      '<root>: anyOf alternative added: {verb="exist"}',
    ]);
    expect(classify({ anyOf: [speed, gap] }, { anyOf: [speed] }).breaking).toEqual([
      '<root>: anyOf alternative removed or changed: {verb="gap"}',
    ]);
    const widenedSpeed = object({ verb: { type: 'string', const: 'speed' }, v: { type: 'number' }, w: { type: 'number' } }, ['verb']);
    expect(classify({ anyOf: [speed, gap] }, { anyOf: [widenedSpeed, gap] }).additive).toEqual([
      '<{verb="speed"}>.w: new optional property',
    ]);
  });

  it('follows $refs (also recursive ones) and reports a change at the path that uses it', () => {
    const before = {
      type: 'object',
      properties: { expr: { $ref: '#/$defs/Expr' } },
      $defs: {
        Expr: { anyOf: [{ type: 'number' }, object({ op: { type: 'string', const: 'add' }, args: { type: 'array', items: { $ref: '#/$defs/Expr' } } }, ['op'])] },
      },
    } satisfies JsonSchema;
    expect(classify(before, before)).toEqual({ additive: [], breaking: [] });
    const narrowed = structuredClone(before) as typeof before;
    (narrowed.$defs.Expr.anyOf[1] as { properties: { args: { maxItems?: number } } }).properties.args.maxItems = 2;
    expect(classify(before, narrowed).breaking).toEqual(['expr<{op="add"}>.args: new maxItems 2 (narrowed)']);
  });

  it('classifies additionalProperties: allowing more is additive, forbidding breaking', () => {
    expect(classify(object({}), { ...(object({}) as object), additionalProperties: true }).additive).toHaveLength(1);
    expect(classify({ type: 'object' }, object({})).breaking).toHaveLength(1);
  });

  it('flags a keyword it does not know as breaking (conservative)', () => {
    expect(classify({ type: 'string' }, { type: 'string', dependentRequired: { a: ['b'] } }).breaking).toEqual([
      '<root>: keyword dependentRequired added',
    ]);
  });
});

describe('the real template schema', () => {
  const current = buildScenarioContract();
  const schema = current.templateSchema as { properties: Record<string, JsonSchema>; required: string[] };

  it('diffs clean against itself', () => {
    expect(diffJsonSchemas(current.templateSchema, current.templateSchema)).toEqual({ additive: [], breaking: [] });
  });

  it('sees a removed top-level field and a new optional one', () => {
    const mutated = structuredClone(schema);
    delete mutated.properties['props'];
    mutated.properties['weatherV2'] = { type: 'string' };
    const diff = diffJsonSchemas(current.templateSchema, mutated);
    expect(diff.breaking.map((c) => `${c.path}: ${c.change}`)).toEqual(['props: property removed or renamed']);
    expect(diff.additive.map((c) => `${c.path}: ${c.change}`)).toEqual(['weatherV2: new optional property']);
  });
});

describe('the committed lock', () => {
  it('is exactly what this build generates (refresh with `pnpm scenario:contract:check --write`)', () => {
    const committed = readFileSync(join(ROOT, SCENARIO_CONTRACT_LOCK_PATH), 'utf8');
    expect(committed).toBe(serializeScenarioContract(buildScenarioContract()));
    expect(parseScenarioContractLock(committed, 'lock').scenarioVersion).toBe(2);
  });

  it('agrees with the Rust sources CI parses', () => {
    const rust = parseRustTemplateContract(
      readFileSync(join(ROOT, RUST_TEMPLATE_VERSION_SOURCE), 'utf8'),
      readFileSync(join(ROOT, RUST_TEMPLATE_STEPS_SOURCE), 'utf8'),
    );
    expect(rust).toEqual({ scenarioTemplateVersion: 2, steps: [] });
    const report = scenarioContractViolations({ locked: buildScenarioContract(), current: buildScenarioContract(), rust });
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual([]);
  });
});

describe('parseRustTemplateContract', () => {
  const templateRs = 'pub const SCENARIO_TEMPLATE_VERSION: u32 = 4;\n';
  it('reads steps, ignoring commented-out ones', () => {
    const upgradeRs = `
pub const TEMPLATE_UPGRADE_STEPS: &[TemplateUpgradeStep] = &[
    TemplateUpgradeStep { from: 2, to: 3, description: "pin ambient", upgrade: upgrade_v2_to_v3 },
    // TemplateUpgradeStep { from: 9, to: 10, description: "draft", upgrade: nope },
    TemplateUpgradeStep {
        from: 3,
        to: 4,
        description: "rename",
        upgrade: upgrade_v3_to_v4,
    },
];`;
    expect(parseRustTemplateContract(templateRs, upgradeRs)).toEqual({
      scenarioTemplateVersion: 4,
      steps: [{ from: 2, to: 3 }, { from: 3, to: 4 }],
    });
  });

  it('refuses a table it cannot read completely', () => {
    const upgradeRs = 'pub const TEMPLATE_UPGRADE_STEPS: &[TemplateUpgradeStep] = &[ TemplateUpgradeStep { to: 3, from: 2 } ];';
    expect(() => parseRustTemplateContract(templateRs, upgradeRs)).toThrow(/1 TemplateUpgradeStep entries, but only 0/);
    expect(() => parseRustTemplateContract('', upgradeRs)).toThrow(/SCENARIO_TEMPLATE_VERSION/);
  });
});

describe('the scenarioVersion bump rule', () => {
  const rust: RustTemplateContract = { scenarioTemplateVersion: 2, steps: [] };
  const locked = (): ScenarioContractLock => structuredClone(buildScenarioContract()) as ScenarioContractLock;

  function withSchema(lock: ScenarioContractLock, edit: (schema: { properties: Record<string, JsonSchema> }) => void) {
    const schema = structuredClone(lock.templateSchema) as { properties: Record<string, JsonSchema> };
    edit(schema);
    return { ...lock, templateSchema: schema };
  }

  it('fails a non-additive schema change without a bump, naming the fix', () => {
    const current = withSchema(locked(), (schema) => {
      delete schema.properties['invariants'];
    });
    const report = scenarioContractViolations({ locked: locked(), current, rust });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatch(/^template schema, invariants: property removed or renamed\. This is not additive and needs a scenarioVersion bump: bump SCENARIO_TEMPLATE_VERSION .* to 3 and add a v2 -> v3 upgrader/);
  });

  it('only asks for a lock refresh on an additive change', () => {
    const current = withSchema(locked(), (schema) => {
      schema.properties['notes'] = { type: 'string' };
    });
    const report = scenarioContractViolations({ locked: locked(), current, rust });
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual(['additive template schema change, notes: new optional property']);
  });

  it('fails a changed or removed absent-field meaning without a bump', () => {
    const current = locked();
    const semantics = current.absentFieldSemantics.map((entry) =>
      entry.id === 'ambient.profile.legacy' ? { ...entry, meaning: { profile: { version: 1, preset: 'off', seed: 'ambient-1' } } } : entry,
    );
    const report = scenarioContractViolations({ locked: locked(), current: { ...current, absentFieldSemantics: semantics }, rust });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain('absent-field semantic "ambient.profile.legacy" changed meaning');
    expect(report.violations[0]).toContain('without a scenarioVersion bump');

    const removed = scenarioContractViolations({
      locked: locked(),
      current: { ...current, absentFieldSemantics: current.absentFieldSemantics.filter((entry) => entry.id !== 'simulation.seed') },
      rust,
    });
    expect(removed.violations[0]).toContain('absent-field semantic "simulation.seed" (simulation) was removed');
  });

  it('treats prose edits and new registry entries as a lock refresh only', () => {
    const current = locked();
    const semantics = [
      ...current.absentFieldSemantics.map((entry) => (entry.id === 'simulation.dtS' ? { ...entry, note: 'reworded' } : entry)),
      { id: 'new.rule', field: 'x', when: 'always', meaning: 1, note: 'n', sources: [] },
    ];
    const report = scenarioContractViolations({ locked: locked(), current: { ...current, absentFieldSemantics: semantics }, rust });
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual(['absent-field semantic "simulation.dtS": note or sources edited', 'new absent-field semantic "new.rule"']);
  });

  it('fails a bump without a TypeScript upgrader step from the previous version', () => {
    const current = withSchema({ ...locked(), scenarioVersion: 3 }, (schema) => {
      delete schema.properties['invariants'];
    });
    const report = scenarioContractViolations({ locked: locked(), current, rust: { scenarioTemplateVersion: 3, steps: [] } });
    expect(report.violations).toContain(
      'scenarioVersion was bumped v2 -> v3 without a TypeScript upgrader step from v2; add { from: 2, to: 3, ... } to SCENARIO_UPGRADE_STEPS (packages/scenario/src/upgrade/chain.ts)',
    );
    expect(report.violations.some((v) => v.includes('exactly one upgrade step from v2'))).toBe(true);
  });

  it('accepts a bump with the step in TS and Rust, and only asks for the lock refresh', () => {
    const base = locked();
    const current = withSchema(
      { ...base, scenarioVersion: 3, upgradeSteps: [...base.upgradeSteps, { from: 2, to: 3, description: 'pin the ambient default' }] },
      (schema) => {
        delete schema.properties['invariants'];
      },
    );
    const bumpedRust = { scenarioTemplateVersion: 3, steps: [{ from: 2, to: 3 }] };
    const report = scenarioContractViolations({ locked: base, current, rust: bumpedRust });
    expect(report.violations).toEqual([]);
    expect(report.stale).toContain('the lock records scenarioVersion 2; this change bumps it to 3');
    expect(report.schemaChanges.breaking).toHaveLength(1);
    // Once the lock is refreshed, the same code passes against it.
    expect(scenarioContractViolations({ locked: current, current, rust: bumpedRust })).toMatchObject({ violations: [], stale: [] });
  });

  it('fails when Rust disagrees with TypeScript', () => {
    const base = locked();
    const current = { ...base, scenarioVersion: 3, upgradeSteps: [...base.upgradeSteps, { from: 2, to: 3, description: 'd' }] };
    const report = scenarioContractViolations({ locked: base, current, rust: { scenarioTemplateVersion: 2, steps: [] } });
    expect(report.violations).toEqual([
      'Rust SCENARIO_TEMPLATE_VERSION is 2 (native/crates/simforge-compiler/src/template.rs) but the TypeScript scenarioVersion is 3',
      'Rust TEMPLATE_UPGRADE_STEPS (native/crates/simforge-compiler/src/template_upgrade.rs) lists [] but the TypeScript chain has template steps [v2->v3]; every template step (from v2 on) must exist in both',
    ]);
  });

  it('fails a version that goes down', () => {
    const report = scenarioContractViolations({
      locked: { ...locked(), scenarioVersion: 3 },
      current: locked(),
      rust,
    });
    expect(report.violations).toContain('scenarioVersion went down: v3 -> v2');
  });
});
