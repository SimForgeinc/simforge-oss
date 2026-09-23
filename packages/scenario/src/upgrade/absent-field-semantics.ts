/**
 * What an ABSENT field means, for every field whose absence the code gives a
 * meaning beyond the schema's own `.default(...)`.
 *
 * Schema defaults (`z.default`, `z.prefault`) are covered by the JSON-schema
 * snapshot in `scenario-contract.lock.json`: changing one is a non-additive
 * schema change. The branches listed here live in CODE instead ("no
 * `simulation` block means the name-derived seed"), where a schema diff cannot
 * see them. Each entry cites the code it describes.
 *
 * The contract:
 *
 * - `meaning` is the machine-comparable semantic. Changing or removing it
 *   changes what existing documents mean, so `pnpm scenario:contract:check`
 *   fails unless `scenarioVersion` is bumped (with an upgrader that writes the
 *   old meaning explicitly into old documents).
 * - Adding an entry, or editing `note`/`sources`, only needs the lock
 *   refreshed (`pnpm scenario:contract:check --write`).
 * - Conformance tests pin the code to these values
 *   (`packages/scenario/src/__tests__/upgrade-chain.test.ts`,
 *   `packages/engine/src/__tests__/absent-field-semantics.test.ts`,
 *   `packages/playback/src/traffic/model.test.ts`, and the Rust
 *   `template_upgrade` tests), so the code cannot drift from the registry
 *   silently either.
 */

/** A JSON value. */
export type AbsentFieldMeaning =
  | null
  | boolean
  | number
  | string
  | readonly AbsentFieldMeaning[]
  | { readonly [key: string]: AbsentFieldMeaning };

/** One "absent means X" rule. */
export interface AbsentFieldSemantic {
  /** Stable key; never reused for another rule. */
  readonly id: string;
  /** Dotted path of the absent field in the document. */
  readonly field: string;
  /** When the rule applies, beyond the field being absent. */
  readonly when: string;
  /** What the absence means. Semantic: changing it needs a scenarioVersion bump. */
  readonly meaning: AbsentFieldMeaning;
  /** Prose for a reader. Not semantic. */
  readonly note: string;
  /** `path:line` of the code that implements the rule. Not semantic. */
  readonly sources: readonly string[];
}

/** The absent-field rules of scenario documents at the current `scenarioVersion`. */
export const SCENARIO_ABSENT_FIELD_SEMANTICS: readonly AbsentFieldSemantic[] = Object.freeze<AbsentFieldSemantic[]>([
  {
    id: 'simulation.seed',
    field: 'simulation',
    when: 'always',
    meaning: { seedIdentity: 'anchor.id when it is a string, else meta.name' },
    note:
      'A pre-pinning document (no simulation block) seeds its simulation from its template id. The one-time pin writes exactly that value as simulation.seed.',
    sources: [
      'packages/scenario/src/schema/v2/template.ts:105 (legacyTemplateSeed)',
      'native/crates/simforge-compiler/src/template.rs:3715 (template_id)',
      'native/crates/simforge-compiler/src/template.rs:3721 (seed_identity)',
      'native/crates/simforge-compiler/src/params.rs:127 (cell_seed)',
    ],
  },
  {
    id: 'simulation.dtS',
    field: 'simulation',
    when: 'always',
    meaning: { dtS: 0.02 },
    note: 'A pre-pinning document simulates at the one fixed step, 20 ms.',
    sources: [
      'packages/scenario/src/schema/v2/template.ts:78 (SIMULATION_DT_S)',
      'packages/scenario/src/schema/v2/template.ts:111 (pinnedSimulationBlock)',
    ],
  },
  {
    id: 'ambient.profile.legacy',
    field: 'extensions["studio.ambientTraffic.profile.v1"]',
    when: 'simulation block absent',
    meaning: { profile: { version: 1, preset: 'city', seed: 'ambient-1' } },
    note:
      'Documents written before pinning get City ambient traffic with seed ambient-1. Immutable old revisions still resolve through this; drafts had it written explicitly by the one-time pin.',
    sources: [
      'packages/engine/src/ambient/profile.ts:181 (defaultAmbientTrafficProfile)',
      'packages/engine/src/ambient/profile.ts:207 (ambientProfileMissingDefault)',
      'native/crates/simforge-compiler/src/ambient.rs:289 (default_ambient_traffic_profile)',
    ],
  },
  {
    id: 'ambient.profile.pinned',
    field: 'extensions["studio.ambientTraffic.profile.v1"]',
    when: 'simulation block present',
    meaning: { profile: { version: 1, preset: 'off', seed: 'ambient-1' } },
    note: 'Pinned (current) documents get no generated traffic unless the author adds a profile.',
    sources: [
      'packages/engine/src/ambient/profile.ts:186 (offAmbientTrafficProfile)',
      'packages/engine/src/ambient/profile.ts:207 (ambientProfileMissingDefault)',
    ],
  },
  {
    id: 'ambient.acceleratedSignalCycles',
    field: 'extensions["studio.ambientTraffic.acceleratedSignalCycles.v1"]',
    when: 'always',
    meaning: { acceleratedSignalCycles: false },
    note: 'Ambient traffic runs the map signals at their real timing unless the flag is exactly true.',
    sources: ['packages/playback/src/traffic/model.ts:66 (ambientSignalCycleSettingsFromExtensions)'],
  },
  {
    id: 'renderSeed.legacy',
    field: 'simulation.seed',
    when: 'simulation block absent',
    meaning: { renderSeed: 'parseInt(content_sha256[0..8], 16)' },
    note:
      'A revision frozen before pinning keeps its legacy render seed, the first 32 bits of its content digest; pinned documents derive it from sha256("simforge.render-seed/v1|" + simulation.seed).',
    sources: ['studio/app/lib/scenario/render-intent-store.ts:219 (renderSeed)'],
  },
  {
    id: 'roles.relative_to.parallelPath',
    field: 'roles[kind=relative_to].rigidOffsetM',
    when: 'extensions.pathSemantics == "parallel_to_reference_actor"',
    meaning: { lateralOffsetM: 'extensions.lateralOffsetM else 0', pathLengthM: 'extensions.pathLengthM else 120', minPathLengthM: 20 },
    note:
      'A relative_to role without a typed rigidOffsetM but with the legacy parallel-path extension follows a route-relative path parallel to its reference actor.',
    sources: [
      'native/crates/simforge-compiler/src/materialize/builder.rs:1348 (legacy_parallel)',
      'native/crates/simforge-compiler/src/materialize/builder.rs:1367 (lateralOffsetM)',
      'native/crates/simforge-compiler/src/materialize/builder.rs:1373 (pathLengthM)',
    ],
  },
]);
