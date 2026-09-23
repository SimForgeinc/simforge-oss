/**
 * The `schema_version` LABEL stored next to a document (`simforge.documents`,
 * `simforge.drafts`, `simforge.revisions`), and on the Studio wire as
 * `schemaVersion`.
 *
 * The canonical label is the decimal `scenarioVersion`, e.g. `"2"`. Writers
 * used to store whatever label a client sent: two drafts on dev carry
 * `"simforge.scenario.v2"`, and older tooling and fixtures used
 * `"simforge.scenario/v2"`. Those two long spellings are the only aliases.
 * Migration `20260923120100_scenario_schema_version_label.sql` relabels drafts
 * and documents; readers normalize revisions (immutable) with
 * {@link normalizeScenarioSchemaVersionLabel}. Anything else is an error.
 */

import { ScenarioFormatError } from '../errors.js';
import { CURRENT_SCENARIO_VERSION, SCENARIO_UPGRADE_STEPS } from './chain.js';

/** The label every writer stores: the current `scenarioVersion` in decimal. */
export const SCENARIO_SCHEMA_VERSION_LABEL = String(CURRENT_SCENARIO_VERSION);

const DECIMAL_LABEL = /^[1-9][0-9]{0,5}$/;
/** The legacy long spellings: `simforge.scenario.v2` and `simforge.scenario/v2`. */
const LONG_LABEL = /^simforge\.scenario[./]v([1-9][0-9]{0,5})$/;

/** Every version this build can read: the start of every step, and the current one. */
function knownVersions(): ReadonlySet<number> {
  return new Set([...SCENARIO_UPGRADE_STEPS.map((step) => step.from), CURRENT_SCENARIO_VERSION]);
}

/**
 * The `scenarioVersion` a label names. Accepts `"2"` and the legacy
 * `"simforge.scenario.v2"` / `"simforge.scenario/v2"` spellings, for any
 * version this build can read.
 *
 * @throws {ScenarioFormatError} `schema_version_label_invalid` for anything else.
 */
export function scenarioVersionFromLabel(label: string): number {
  const trimmed = label.trim();
  const match = DECIMAL_LABEL.test(trimmed) ? trimmed : LONG_LABEL.exec(trimmed)?.[1];
  const version = match === undefined ? undefined : Number(match);
  if (version === undefined || !knownVersions().has(version)) {
    throw new ScenarioFormatError(
      `unknown scenario schema_version label ${JSON.stringify(label)}; expected ${JSON.stringify(SCENARIO_SCHEMA_VERSION_LABEL)}`,
      version,
      'schema_version_label_invalid',
    );
  }
  return version;
}

/**
 * The canonical spelling of a STORED label (`"simforge.scenario.v2"` becomes
 * `"2"`). For read paths, including immutable revisions.
 *
 * @throws {ScenarioFormatError} For a label naming no known version.
 */
export function normalizeScenarioSchemaVersionLabel(label: string): string {
  return String(scenarioVersionFromLabel(label));
}

/**
 * The label a WRITE stores. Writers write only the current version, so a
 * client may send the canonical label, its long spelling, or nothing; any
 * other label (an older version, a typo) is refused.
 *
 * @throws {ScenarioFormatError} `schema_version_label_invalid`.
 */
export function writableScenarioSchemaVersionLabel(label: string | undefined): string {
  if (label === undefined) return SCENARIO_SCHEMA_VERSION_LABEL;
  const version = scenarioVersionFromLabel(label);
  if (version !== CURRENT_SCENARIO_VERSION) {
    throw new ScenarioFormatError(
      `schema_version ${JSON.stringify(label)} is not writable: documents are only written at the current version ${JSON.stringify(SCENARIO_SCHEMA_VERSION_LABEL)}`,
      version,
      'schema_version_label_invalid',
    );
  }
  return SCENARIO_SCHEMA_VERSION_LABEL;
}
