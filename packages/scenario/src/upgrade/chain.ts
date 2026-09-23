/**
 * The scenario DOCUMENT upgrader chain.
 *
 * A stored document keeps the `scenarioVersion` it was written with, forever:
 * revisions are immutable, and drafts are only ever rewritten by an author's
 * own save. Readers bring an old document up to {@link CURRENT_SCENARIO_VERSION}
 * **on read**, through one pure step per version, and then parse it strictly.
 * Writers only ever write the current version.
 *
 * ## The bump rule
 *
 * `scenarioVersion` is an integer. It MUST be bumped whenever an existing
 * document could change meaning under the new code:
 *
 * - a non-additive schema change (a removed or renamed field, a type change, a
 *   new required field, a narrowed enum or bound, a changed default);
 * - a changed "absent means legacy default" rule
 *   ({@link SCENARIO_ABSENT_FIELD_SEMANTICS}).
 *
 * Each bump adds exactly one step here, `from: N, to: N + 1`, that rewrites a
 * vN document into an equivalent vN+1 document (for example by writing the old
 * default explicitly). Template steps (from >= 2) are mirrored one-to-one in
 * Rust (`native/crates/simforge-compiler/src/template_upgrade.rs`,
 * `TEMPLATE_UPGRADE_STEPS`). `pnpm scenario:contract:check` enforces all of
 * this in CI against `packages/scenario/scenario-contract.lock.json`
 * (`src/contract/contract.ts`).
 *
 * ## Why on read
 *
 * Rewriting stored content with one-off scripts mutates history, changes
 * `content_sha256` under revisions that cite it, and (as `migrate-scenarios`
 * did) silently skips what it cannot parse. An upgrader applied on read does
 * none of that: the stored bytes and their digests stay as they were, and a
 * document the chain cannot read fails loudly with a {@link ScenarioFormatError}.
 */

import { ScenarioFormatError } from '../errors.js';
import { readScenarioVersion, v1ToTemplateV2, type MigrationNote } from '../migrate-v2.js';
import { SCENARIO_VERSION as SCENE_V1_VERSION } from '../schema/v1.js';
import { SCENARIO_TEMPLATE_VERSION, type ScenarioTemplateV2 } from '../schema/v2/template.js';
import { parseScenario, parseTemplate } from '../serialize.js';

/** The `scenarioVersion` this build writes, and the only one `parseTemplate` accepts. */
export const CURRENT_SCENARIO_VERSION: number = SCENARIO_TEMPLATE_VERSION;

/**
 * The first `scenarioVersion` that is a template. Steps from this version on
 * are shared with the native compiler; the steps below it (v1 scenes) are a
 * TypeScript-only importer, and the native compiler rejects those documents.
 */
export const FIRST_TEMPLATE_VERSION = 2;

/** A raw (unparsed) scenario document: a JSON object. */
export type RawScenarioDocument = Record<string, unknown>;

/** One pure upgrade step: a vN document in, the equivalent vN+1 document out. */
export interface ScenarioUpgradeStep {
  readonly from: number;
  readonly to: number;
  /** What the step changes, in one sentence; reported to readers. */
  readonly description: string;
  /**
   * Pure: never mutates its input, reads no clock, map or environment.
   * `notes` collects anything a human should know about the conversion.
   */
  readonly upgrade: (raw: RawScenarioDocument, notes: MigrationNote[]) => RawScenarioDocument;
}

/**
 * Every upgrade step, in order. Exactly one step starts at each version below
 * {@link CURRENT_SCENARIO_VERSION}, and each goes up by one.
 */
export const SCENARIO_UPGRADE_STEPS: readonly ScenarioUpgradeStep[] = Object.freeze([
  {
    from: SCENE_V1_VERSION,
    to: 2,
    description:
      'v1 scene to v2 template: absolute poses kept as scene_absolute roles, anchor pinned to the source map (TypeScript importer only)',
    upgrade: (raw, notes) => v1ToTemplateV2(parseScenario(raw), notes),
  },
]);

/** A step as reported to a reader (no function). */
export interface AppliedScenarioUpgradeStep {
  readonly from: number;
  readonly to: number;
  readonly description: string;
}

/** Outcome of {@link upgradeScenarioDocument}. */
export interface ScenarioUpgradeResult {
  /** The document at {@link CURRENT_SCENARIO_VERSION}, still raw (not parsed). */
  readonly document: RawScenarioDocument;
  /** The `scenarioVersion` the input carried. */
  readonly fromVersion: number;
  /** The steps applied, in order. Empty when the input was already current. */
  readonly steps: readonly AppliedScenarioUpgradeStep[];
  /** Everything the steps want a human to know. Empty when no step ran. */
  readonly notes: readonly MigrationNote[];
}

function isRecord(value: unknown): value is RawScenarioDocument {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bring a raw stored document up to {@link CURRENT_SCENARIO_VERSION}.
 *
 * The input is never mutated. A current document is returned as is (the same
 * object), with no steps.
 *
 * @throws {ScenarioFormatError} `not_a_scenario` for a non-object or a missing
 *   or non-integer `scenarioVersion`; `scenario_version_newer` for a document
 *   written by a newer SimForge (this installation must be upgraded to read
 *   it); `scenario_version_unknown` for a version no step starts from.
 * @throws {ScenarioValidationError} When a step's own strict input parse fails
 *   (a malformed v1 scene).
 */
export function upgradeScenarioDocument(raw: unknown): ScenarioUpgradeResult {
  if (!isRecord(raw)) {
    throw new ScenarioFormatError('not a scenario document: expected a JSON object', undefined, 'not_a_scenario');
  }
  const fromVersion = readScenarioVersion(raw);
  if (fromVersion === undefined) {
    throw new ScenarioFormatError(
      'not a scenario document: scenarioVersion must be an integer',
      undefined,
      'not_a_scenario',
    );
  }
  if (fromVersion > CURRENT_SCENARIO_VERSION) {
    throw new ScenarioFormatError(
      `this scenario was saved by a newer SimForge (document schema v${fromVersion}); this installation reads up to v${CURRENT_SCENARIO_VERSION}. Upgrade SimForge to open it.`,
      fromVersion,
      'scenario_version_newer',
    );
  }
  const applied: AppliedScenarioUpgradeStep[] = [];
  const notes: MigrationNote[] = [];
  let document = raw;
  let version = fromVersion;
  while (version < CURRENT_SCENARIO_VERSION) {
    const step = SCENARIO_UPGRADE_STEPS.find((candidate) => candidate.from === version);
    if (!step) {
      throw new ScenarioFormatError(
        `unsupported scenario format: document schema v${version}; this build upgrades v${SCENARIO_UPGRADE_STEPS[0]?.from ?? CURRENT_SCENARIO_VERSION} through v${CURRENT_SCENARIO_VERSION}`,
        version,
        'scenario_version_unknown',
      );
    }
    const next = step.upgrade(document, notes);
    const produced = readScenarioVersion(next);
    if (produced !== step.to) {
      // A step that does not produce its own declared version is a bug in this
      // package, never a property of the stored document.
      throw new Error(`scenario upgrade step v${step.from} -> v${step.to} produced scenarioVersion ${String(produced)}`);
    }
    applied.push({ from: step.from, to: step.to, description: step.description });
    document = next;
    version = step.to;
  }
  return { document, fromVersion, steps: applied, notes };
}

/**
 * Read a stored document: {@link upgradeScenarioDocument}, then the strict
 * {@link parseTemplate}. The read path for every stored draft and revision.
 *
 * @throws {ScenarioFormatError} See {@link upgradeScenarioDocument}.
 * @throws {ScenarioValidationError} When the (upgraded) document is invalid.
 */
export function readScenarioDocument(raw: unknown): ScenarioTemplateV2 {
  return parseTemplate(upgradeScenarioDocument(raw).document);
}
