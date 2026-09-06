/**
 * Materialization documents and the native compile façade.
 *
 * `template × map × site × seed → concrete SimScenarioInput + InstanceManifest`
 * is computed by the native compiler (`simforge-compiler::materialize`). This
 * module defines the documents it emits and the `*With(module, …)` typed entries
 * over the native module; `@simforge-oss/compiler/node` binds them to the addon.
 */

import type { ScenarioTemplateV2, Condition as V2Condition } from '@simforge-oss/scenario';
import type { CatalogEntry } from '@simforge-oss/asset-catalog/metadata';
import type {
  AmbientTrafficProfile,
  AmbientTrafficProvenance,
  ArrivalSolution,
  Condition as SimCondition,
  NativeModule,
  ScenarioInput,
  SimActor,
  SimIssue,
  SimScenarioInput,
  StaticProp,
} from '@simforge-oss/engine';
import { guard } from '@simforge-oss/native-runtime/shared';

import type { MatchedSite, Verdict } from './anchor/index.js';
import type { MapBundle } from './types.js';

/** The full replay key: everything an instance needs to be re-derived exactly. */
export interface ReplayKey {
  readonly templateId: string;
  readonly templateVersion: number;
  /** Content hash of the whole authored template — the version field alone lies. */
  readonly templateDigest: string;
  readonly mapId: string;
  /** Matcher/map-intel digest used to derive the site id. */
  readonly matcherIndexDigest: string;
  /** Engine lane-graph digest written into traces. */
  readonly engineGraphDigest: string;
  readonly siteId: string;
  readonly matcherVersion: string;
  readonly solverVersion: string;
  readonly paramSeed: string;
  readonly drawIndex: number;
  /** Hash of the resolved ambient-traffic profile, or the literal `'none'`. */
  readonly ambientProfileHash: string;
}

/** Operational conditions reserved by a catalog slot, in the catalog's human-readable vocabulary. */
export interface CatalogVariantApplication {
  readonly id: string;
  readonly title: string;
  readonly weather: string;
  readonly timeOfDay: string;
  readonly traffic: string;
  readonly visibility: string;
}

export interface AppliedCatalogVariant extends CatalogVariantApplication {
  readonly concrete: NonNullable<SimScenarioInput['operationalConditions']>;
}

export interface InitialInteractionOutcome {
  readonly interactionId: string;
  readonly actorId: string;
  readonly verb: string;
  readonly timeS: number;
  readonly outcome: 'executed';
  readonly basis: 'folded_initial_state';
}

/** Provenance of the ambient-only warm-up folded into the generated population's initial state. */
export interface AmbientSettleProvenance {
  readonly version: 1;
  readonly settleSeconds: number;
  readonly cohortRadiusM: number;
  readonly cohortMaxActors: number;
  readonly settledActorIds: readonly string[];
  readonly droppedActorIds: readonly string[];
  readonly settleInputHash: string;
}

export interface MaterializationNote {
  path: string;
  reason: string;
  /**
   * Informational notes describe a semantics-preserving lowering decision.
   * They must remain visible in evidence, but they are not a reason to refuse
   * editable playback. Omitted means the note records semantic loss.
   */
  impact?: 'informational';
}

/** Notes which mean the authored document could not be represented exactly. */
export function materializationSemanticLosses(notes: readonly MaterializationNote[]): MaterializationNote[] {
  return notes.filter((note) => note.impact !== 'informational');
}

export interface InstanceManifest {
  readonly kind: 'scenario-instance-manifest';
  readonly manifestVersion: 1;
  readonly replayKey: ReplayKey;
  readonly instanceId: string;
  readonly archetype: string | null;
  readonly negativeControl: boolean;
  readonly metricSubject: string | null;
  /** Catalog operational variant closed over the exact engine conditions applied; `null` for ad-hoc instantiation. */
  readonly operationalVariant: AppliedCatalogVariant | null;
  readonly site: {
    readonly siteId: string;
    readonly score: number;
    readonly verdict: Verdict;
    readonly originFeatureId: string;
    readonly entryLaneRsl: string;
    readonly egoTurn: string | null;
    readonly degradationSummary: string;
    readonly matchedReasons: string[];
  };
  readonly params: {
    readonly values: Record<string, number>;
    readonly categorical: Record<string, string>;
    readonly rejectedConstraints: string[];
  };
  readonly actors: Array<{
    readonly id: string;
    readonly actorKind: SimActor['kind'];
    readonly roleKind: string;
    readonly laneRsl: string | null;
    readonly spawnS: number;
    readonly initialSpeedMps: number;
    readonly bindingStatus: string;
  }>;
  /** Hash-covered fixed catalog geometry expanded from the authored v2 props. */
  readonly props: StaticProp[];
  readonly arrival: ArrivalSolution[];
  /** `sha256(canonicalJson(parsedInput))` — matches `trace.header.inputHash`. */
  readonly inputHash: string;
  readonly feasible: boolean;
  readonly issues: SimIssue[];
  /** Complete provenance of the generated background population; absent when none was requested. */
  readonly ambient?: AmbientTrafficProvenance;
  /** Provenance of the ambient-only warm-up; absent when no settle ran. */
  readonly ambientSettle?: AmbientSettleProvenance;
  /** Commands already accepted into the concrete t=0 world rather than left for the runtime trigger evaluator. */
  readonly initialInteractionOutcomes: InitialInteractionOutcome[];
  /** Lowering diagnostics; only notes without informational impact denote loss. */
  readonly notes: MaterializationNote[];
}

export interface MaterializeResult {
  readonly input: SimScenarioInput;
  readonly manifest: InstanceManifest;
  /** Diagnostic predicates lowered in the same map/parameter scope as actors; they never change the executed input. */
  readonly observations: readonly { readonly id: string; readonly condition: SimCondition }[];
}

/** Options accepted by `compileTemplateWith`; serialised as the native `optionsJson`. */
export interface MaterializeOptions {
  readonly observations?: readonly { readonly id: string; readonly condition: V2Condition }[];
  readonly drawIndex?: number;
  /** Overrides the derived per-cell seed. `--seed` on the command line. */
  readonly seed?: string | undefined;
  /** Operational conditions reserved by a catalog slot; applied to the concrete engine input. */
  readonly variant?: CatalogVariantApplication | undefined;
  /**
   * Generated background road users. Absent, or `preset: 'off'`, reproduces the
   * empty-road behaviour byte for byte. Ambient actors are appended AFTER the
   * authored feasibility verdict and BEFORE `inputHash` is taken.
   */
  readonly ambient?: AmbientTrafficProfile | undefined;
  /** Seconds of ambient-only integration applied before `t = 0`; `0` or absent disables. */
  readonly ambientSettleSeconds?: number | undefined;
  /** Validated user-imported asset metadata. Entries cannot shadow built-ins. */
  readonly catalogEntries?: readonly CatalogEntry[] | undefined;
  /** Reject observations the engine cannot evaluate instead of noting them. */
  readonly strictObservations?: boolean | undefined;
}

/** One compiled instance: the executable scenario handle plus its evidence. */
export interface CompiledTemplate extends MaterializeResult {
  /** The validated native scenario; pass it straight to a session or run. */
  readonly scenario: ScenarioInput;
}

/** Materialise `template × bundle × site × seed` natively. `site` is a site id, a matched site, or `null` for the top-ranked site. */
export function compileTemplateWith(
  module: NativeModule,
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  site: string | MatchedSite | null,
  options: MaterializeOptions = {},
): CompiledTemplate {
  const { seed, ...rest } = options;
  const siteId = site === null || typeof site === 'string' ? site : site.siteId;
  const optionsJson = Object.keys(rest).length === 0 ? null : JSON.stringify(rest);
  const compiled = guard(() => module.compileTemplate(JSON.stringify(template), bundle.native, siteId, seed ?? null, optionsJson));
  return {
    scenario: compiled.input,
    input: JSON.parse(compiled.input.toJson()) as SimScenarioInput,
    manifest: JSON.parse(compiled.manifestJson) as InstanceManifest,
    observations: JSON.parse(compiled.observationsJson) as MaterializeResult['observations'],
  };
}

/** Site ids in `bundle` that satisfy the template's anchor, ranked by the native matcher. */
export function findSitesWith(module: NativeModule, template: ScenarioTemplateV2, bundle: MapBundle): string[] {
  return guard(() => module.findSites(JSON.stringify(template), bundle.native));
}

/** Replay-key identity of a template: the stable id and the content hash of its parameter block. */
export interface TemplateIdentity {
  readonly templateId: string;
  readonly paramsVersion: string;
}

export function templateIdentityWith(module: NativeModule, template: ScenarioTemplateV2): TemplateIdentity {
  return JSON.parse(guard(() => module.templateIdentityJson(JSON.stringify(template)))) as TemplateIdentity;
}

export function cellSeedWith(module: NativeModule, templateId: string, paramsVersion: string, siteId: string, drawIndex: number): string {
  return guard(() => module.cellSeed(templateId, paramsVersion, siteId, drawIndex));
}
