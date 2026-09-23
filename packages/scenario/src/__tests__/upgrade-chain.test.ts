/**
 * The document upgrader chain (applied on read), the schema_version label
 * normalizer, and the absent-field registry's agreement with this package's
 * own code.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioFormatError, ScenarioValidationError } from '../errors.js';
import { simContentHash } from '../sim-content-hash.js';
import { SIMULATION_DT_S, legacyTemplateSeed, pinnedSimulationBlock } from '../schema/v2/template.js';
import { parseTemplate } from '../serialize.js';
import { SCENARIO_ABSENT_FIELD_SEMANTICS } from '../upgrade/absent-field-semantics.js';
import {
  CURRENT_SCENARIO_VERSION,
  FIRST_TEMPLATE_VERSION,
  SCENARIO_UPGRADE_STEPS,
  readScenarioDocument,
  upgradeScenarioDocument,
} from '../upgrade/chain.js';
import {
  SCENARIO_SCHEMA_VERSION_LABEL,
  normalizeScenarioSchemaVersionLabel,
  scenarioVersionFromLabel,
  writableScenarioSchemaVersionLabel,
} from '../upgrade/labels.js';
import { validScenario } from './fixtures.js';
import { ltapTemplateInput } from './v2-fixtures.js';

function formatError(run: () => unknown): ScenarioFormatError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScenarioFormatError) return error;
    throw error;
  }
  throw new Error('expected a ScenarioFormatError');
}

describe('upgradeScenarioDocument', () => {
  it('is at the template version and has one step from each older version', () => {
    expect(CURRENT_SCENARIO_VERSION).toBe(2);
    expect(FIRST_TEMPLATE_VERSION).toBe(2);
    expect(SCENARIO_UPGRADE_STEPS.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
  });

  it('returns a current document as is, with no steps', () => {
    const raw = ltapTemplateInput() as Record<string, unknown>;
    const result = upgradeScenarioDocument(raw);
    expect(result.document).toBe(raw);
    expect(result).toMatchObject({ fromVersion: 2, steps: [], notes: [] });
    expect(readScenarioDocument(raw)).toEqual(parseTemplate(raw));
  });

  it('upgrades a v1 scene through the importer step without touching the input', () => {
    const scene = validScenario();
    const before = JSON.stringify(scene);
    const result = upgradeScenarioDocument(scene);
    expect(JSON.stringify(scene)).toBe(before);
    expect(result.fromVersion).toBe(1);
    expect(result.steps.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
    expect(result.document['scenarioVersion']).toBe(2);
    expect(result.notes.some((note) => note.code === 'anchor_pinned_no_site')).toBe(true);
    const template = readScenarioDocument(scene);
    expect(template.scenarioVersion).toBe(2);
    expect(template.meta.tags).toContain('migrated:v1');
  });

  it('refuses a newer document loudly: this installation must be upgraded', () => {
    const newer = { ...(ltapTemplateInput() as Record<string, unknown>), scenarioVersion: CURRENT_SCENARIO_VERSION + 1 };
    const error = formatError(() => readScenarioDocument(newer));
    expect(error.code).toBe('scenario_version_newer');
    expect(error.version).toBe(3);
    expect(error.message).toBe(
      'this scenario was saved by a newer SimForge (document schema v3); this installation reads up to v2. Upgrade SimForge to open it.',
    );
  });

  it('refuses unknown versions and non-documents', () => {
    expect(formatError(() => upgradeScenarioDocument({ scenarioVersion: 0 })).code).toBe('scenario_version_unknown');
    for (const bad of [null, 42, [], {}, { scenarioVersion: '2' }, { scenarioVersion: 1.5 }]) {
      expect(formatError(() => upgradeScenarioDocument(bad)).code).toBe('not_a_scenario');
    }
  });

  it('parses strictly after upgrading: an invalid v1 scene or v2 template is a validation error', () => {
    expect(() => readScenarioDocument({ scenarioVersion: 1 })).toThrow(ScenarioValidationError);
    expect(() => readScenarioDocument({ ...(ltapTemplateInput() as Record<string, unknown>), bogus: true })).toThrow(ScenarioValidationError);
  });
});

describe('schema_version labels', () => {
  it('normalizes the long spelling on read', () => {
    expect(SCENARIO_SCHEMA_VERSION_LABEL).toBe('2');
    expect(normalizeScenarioSchemaVersionLabel('2')).toBe('2');
    expect(normalizeScenarioSchemaVersionLabel('simforge.scenario.v2')).toBe('2');
    expect(normalizeScenarioSchemaVersionLabel('simforge.scenario/v2')).toBe('2');
    expect(normalizeScenarioSchemaVersionLabel(' 2 ')).toBe('2');
    expect(normalizeScenarioSchemaVersionLabel('1')).toBe('1');
    expect(scenarioVersionFromLabel('simforge.scenario.v1')).toBe(1);
  });

  it('refuses labels that name no known version', () => {
    for (const bad of ['', 'v2', '3', '02', 'simforge.scenario.v3', 'simforge.scenario.2', 'scenario.v2', '2.0', 'simforge.scenario-v2', 'simforge.scenario.v2 extra']) {
      const error = formatError(() => normalizeScenarioSchemaVersionLabel(bad));
      expect(error.code).toBe('schema_version_label_invalid');
    }
  });

  it('writes only the current label', () => {
    expect(writableScenarioSchemaVersionLabel(undefined)).toBe('2');
    expect(writableScenarioSchemaVersionLabel('2')).toBe('2');
    expect(writableScenarioSchemaVersionLabel('simforge.scenario.v2')).toBe('2');
    expect(writableScenarioSchemaVersionLabel('simforge.scenario/v2')).toBe('2');
    expect(formatError(() => writableScenarioSchemaVersionLabel('1')).message).toContain('not writable');
    expect(formatError(() => writableScenarioSchemaVersionLabel('garbage')).code).toBe('schema_version_label_invalid');
  });
});

describe('SCENARIO_ABSENT_FIELD_SEMANTICS agrees with this package', () => {
  const meaning = (id: string) => {
    const entry = SCENARIO_ABSENT_FIELD_SEMANTICS.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no absent-field semantic ${id}`);
    return entry.meaning as Record<string, unknown>;
  };

  it('has unique ids and cites its code', () => {
    const ids = SCENARIO_ABSENT_FIELD_SEMANTICS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SCENARIO_ABSENT_FIELD_SEMANTICS) {
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) expect(source).toMatch(/^[\w./-]+:\d+( \(.+\))?$/);
    }
  });

  it('simulation.seed: anchor.id when a string, else meta.name', () => {
    expect(meaning('simulation.seed')).toEqual({ seedIdentity: 'anchor.id when it is a string, else meta.name' });
    expect(legacyTemplateSeed({ anchor: { id: 'anchor-1' }, meta: { name: 'Name' } })).toBe('anchor-1');
    expect(legacyTemplateSeed({ anchor: {}, meta: { name: 'Name' } })).toBe('Name');
    expect(legacyTemplateSeed({ anchor: { id: null }, meta: { name: 'Name' } })).toBe('Name');
  });

  it('simulation.dtS: 0.02', () => {
    expect(meaning('simulation.dtS')).toEqual({ dtS: SIMULATION_DT_S });
    expect(pinnedSimulationBlock({ meta: { name: 'n' } }).dtS).toBe(0.02);
  });

  it('an unpinned document is identified by its name (the seed derives from it)', () => {
    const unpinned = parseTemplate({ ...(ltapTemplateInput() as Record<string, unknown>), anchor: { ...(ltapTemplateInput().anchor as object), id: undefined } });
    const renamed = { ...unpinned, meta: { ...unpinned.meta, name: 'renamed' } };
    expect(simContentHash(renamed)).not.toBe(simContentHash(unpinned));
  });
});
