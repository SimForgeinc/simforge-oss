/**
 * Execution packages: the one portable compilation/export authority.
 *
 * Local Studio's compiler worker and the Cloud compiler service both call
 * this module. It resolves a map-bound revision to the exact input the native
 * engine executes, exports that authored, native-resolved input as the
 * canonical OpenSCENARIO XML 1.4 trajectory-replay document, validates the
 * document against the pinned official XSD and assembles the capability
 * report, compiler provenance and execution manifest. The canonical `xosc`
 * artifact is what Native rendering and portable export consume; it carries
 * the authored model identities and every authored actor.
 *
 * Hosts keep what is genuinely theirs: claim acquisition, map-closure
 * download, auth, queues and persistence. A consumer that cannot spawn the
 * authored identities (a CARLA fleet, say) enters only as an explicitly named
 * {@link ExecutionProjection}: it derives its own input from the canonical
 * resolved input, receives its own distinct artifact and is recorded under its
 * name in the manifest and provenance. Projections never alter the canonical
 * artifact or the digest contract with the browser.
 */

import { createHash } from 'node:crypto';

import {
  ambientTrafficProfileForDocument,
  canonicalJson,
  type AmbientTrafficProvenance,
  type LaneGraph,
  type SimScenarioInput,
  type SimTrace,
} from '@simforge-oss/engine';
import { engine, runtimeIdentity } from '@simforge-oss/engine/node';
import { exportOpenScenarioXml14, type AsamExportResult, type AsamExportWarning } from '@simforge-oss/openscenario';
import {
  OFFICIAL_OPENSCENARIO_140_XSD,
  validateOpenScenarioXml14,
  type OpenScenarioXml14Validation,
} from '@simforge-oss/openscenario/node';
import { readScenarioDocument, serializeTemplate, type ScenarioTemplateV2 } from '@simforge-oss/scenario';

import type { MapControlPlan } from './map-signals.js';
import { compileTemplateAtSiteWith, compileTemplateWith, materializationSemanticLosses, resolveSiteWith, type MaterializeOptions } from './materialize.js';
import { adaptTemplateNotesWith, matchSitesWith } from './match.js';
import { selectPlayableSite } from '@simforge-oss/playback';
import { clampDeclaredAxisHolds, type AxisUntilClamp } from './template-axis-clamp.js';
import type { MapBundle } from './types.js';
import { buildXodrElevationResolver } from './xodr-elevation.js';
import { persistAmbientTurnVerdictsToDisk } from './maps.js';
import {
  EMPTY_SCENARIO_SITE_ID,
  emptyScenarioBaseInput,
  emptyScenarioManifest,
  isEmptyScenarioClockActor,
  isEmptyScenarioTemplate,
  withoutRedundantEmptyScenarioClock,
} from './empty-scenario.js';

export const EXECUTION_PACKAGE_CONTRACT = 'uniscenario.execution-package/v1';
export const CAPABILITY_REPORT_CONTRACT = 'uniscenario.capability-report/v1';
export const COMPILER_PROVENANCE_CONTRACT = 'uniscenario.compiler-provenance/v1';
export const EXECUTION_OPENSCENARIO_PROFILE = 'ASAM OpenSCENARIO XML 1.4';
/** `sha256("{}")`: the config digest a disabled ambient provenance must carry. */
export const EMPTY_AMBIENT_CONFIG_SHA256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
export const MAX_EXECUTION_XOSC_BYTES = 128 * 1024 * 1024;

export type AmbientExecutionMode = 'disabled' | 'native' | 'sumo';

/** The browser-materialized traffic artifact a revision's execution is bound to. */
export interface MaterializedTrafficIdentity {
  readonly artifactId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Digest of the concrete input the browser simulated; see {@link executionSourceInputDigest}. */
  readonly sourceInputDigest: string;
  readonly mapAssetId: string;
  readonly mapVersionId: string;
}

interface AmbientProvenanceBase {
  readonly ambientConfig: Readonly<Record<string, unknown>>;
  readonly configSha256: string;
  readonly resultSha256: string;
  readonly materializedTraffic: MaterializedTrafficIdentity;
}

/** Ambient-traffic provenance of the revision being compiled, as the host claimed it. */
export type ExecutionAmbientProvenance =
  | (AmbientProvenanceBase & { readonly mode: 'disabled' })
  | (AmbientProvenanceBase & { readonly mode: 'native'; readonly runtimeVersion: string; readonly seed: string | number })
  | (AmbientProvenanceBase & {
      readonly mode: 'sumo';
      readonly sumoVersion: string;
      readonly networkSha256: string;
      readonly seed: string | number;
    });

export interface ConcreteExecutionInput {
  /** Materialized, map-controlled, studio-decorated and ambient-expanded input. */
  readonly input: SimScenarioInput;
  readonly siteId: string;
  readonly materialization: unknown;
  readonly ambientTraffic: AmbientTrafficProvenance;
}

export interface ResolvedExecutionInput {
  /** The revision as authored; serialized for the content digest. */
  readonly template: ScenarioTemplateV2;
  /** Mechanical `until` truncations applied before validation; runtime behavior is unchanged. */
  readonly axisUntilClamps: readonly AxisUntilClamp[];
  readonly concrete: ConcreteExecutionInput;
  /** The exact input the native engine executes; the export and the digest are taken from it. */
  readonly resolvedInput: SimScenarioInput;
  /**
   * The refined concrete input handed to the engine constructor (playback
   * refinements applied, before the engine's own normalization). Running the
   * clip from this is exactly what the editor's scenario worker runs, so the
   * authoritative trace and the editor's local trace share one identity.
   */
  readonly executedInput: SimScenarioInput;
}

/**
 * A consumer-specific adaptation of the canonical resolved input. The
 * projection is named (`carla`), bound to its own artifact kind and recorded
 * in the manifest and provenance under that name. Returning `null` from
 * {@link ExecutionProjection.project} declares that the canonical artifact
 * already serves the consumer: no extra artifact is emitted and the record
 * points at the canonical `xosc` digest.
 */
export interface ExecutionProjection {
  readonly artifactKind: string;
  project(resolved: ResolvedExecutionInput): {
    readonly input: SimScenarioInput | null;
    readonly provenance: Readonly<Record<string, unknown>>;
  };
}

export type ExecutionArtifactMediaType = 'application/xml' | 'application/json';

export interface ExecutionArtifact {
  /** `xosc`, `capability-report`, `compiler-provenance`, `execution-manifest`, or a projection's artifact kind. */
  readonly kind: string;
  readonly mediaType: ExecutionArtifactMediaType;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ExecutionPackage {
  /** Canonical artifacts first, projection artifacts next, the manifest last. */
  readonly artifacts: readonly ExecutionArtifact[];
  readonly manifestSha256: string;
  readonly xsdSha256: string;
  readonly sourceInputDigest: string;
}

export type OpenScenarioXmlValidator = (xml: string, xsdPath: string) => Promise<OpenScenarioXml14Validation>;

export interface ExecutionPackageRequest {
  readonly revisionId: string;
  /** `sha256(serializeTemplate(parseTemplate(canonicalContent)))`, as the host stored it. */
  readonly expectedContentSha256: string;
  readonly canonicalContent: unknown;
  readonly catalogEntries?: MaterializeOptions['catalogEntries'];
  readonly mapVersionId: string;
  readonly mapAssetId: string;
  readonly runtimeMapName: string;
  readonly map: MapBundle;
  readonly xodr: string;
  readonly xodrSha256: string;
  readonly mapArtifactDigests: Readonly<Record<string, string>>;
  readonly coordinateSystemId: string;
  readonly coordinateSystemSha256: string;
  readonly assetCatalogVersionId: string;
  readonly assetCatalogManifestSha256: string;
  readonly ambient: ExecutionAmbientProvenance;
  /** The host's compiler identity, recorded in provenance and the XOSC header. */
  readonly compilerVersion: string;
  readonly xsdPath: string;
  readonly validateXml?: OpenScenarioXmlValidator | undefined;
  readonly projections?: Readonly<Record<string, ExecutionProjection>> | undefined;
  /**
   * The revision's authoritative simulation. When present the package is a
   * derived view of it: the resolved input comes from its resolution record
   * and the XOSC trajectories from its trace. Nothing is resolved,
   * materialized or simulated again, so no traffic engine runs here.
   */
  readonly simulation?: AuthoritativeSimulationInput | undefined;
}

/** The authoritative simulation an execution package is derived from. */
export interface AuthoritativeSimulationInput {
  readonly simKey: string;
  readonly traceSha256: string;
  readonly trace: SimTrace;
  /** The `simforge.sim-resolution/v1` record the simulation stored beside its trace. */
  readonly resolution: {
    readonly resolvedInputDigest: string;
    readonly resolvedInput: SimScenarioInput;
    readonly ambientTraffic: AmbientTrafficProvenance;
    readonly siteId: string;
    readonly materialization: unknown;
    readonly axisUntilClamps: readonly AxisUntilClamp[];
  };
}

/** Rebuild the resolution from a stored record, verifying it names exactly the traced input. */
export function resolutionFromSimulation(canonicalContent: unknown, simulation: AuthoritativeSimulationInput): ResolvedExecutionInput {
  const { resolution, trace } = simulation;
  const digest = executionSourceInputDigest(resolution.resolvedInput);
  if (digest !== resolution.resolvedInputDigest || trace.header.inputHash !== digest) {
    throw new Error(`simulation_resolution_mismatch: record ${resolution.resolvedInputDigest}, input ${digest}, trace ${trace.header.inputHash}`);
  }
  return {
    template: readScenarioDocument(canonicalContent),
    axisUntilClamps: resolution.axisUntilClamps,
    concrete: {
      input: resolution.resolvedInput,
      siteId: resolution.siteId,
      materialization: resolution.materialization,
      ambientTraffic: resolution.ambientTraffic,
    },
    resolvedInput: resolution.resolvedInput,
    executedInput: resolution.resolvedInput,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function artifact(kind: string, mediaType: ExecutionArtifactMediaType, bytes: Uint8Array): ExecutionArtifact {
  return { kind, mediaType, bytes, sha256: sha256(bytes) };
}

function withMapControls(input: SimScenarioInput, controls: MapControlPlan): SimScenarioInput {
  const signalIds = new Set(input.signalPrograms.map((program) => program.id));
  const roadControlIds = new Set(input.roadControls.map((control) => control.id));
  return {
    ...input,
    signalPrograms: [...input.signalPrograms, ...controls.signalPrograms.filter((item) => !signalIds.has(item.id))],
    roadControls: [...input.roadControls, ...controls.roadControls.filter((item) => !roadControlIds.has(item.id))],
  };
}

function assertRuntimeAssetIdentities(input: SimScenarioInput): void {
  for (const actor of input.actors) {
    // The blank world's clock is never rendered and has no catalog model.
    if (isEmptyScenarioClockActor(actor)) continue;
    const assetIds = actor.tags
      .filter((tag) => tag.startsWith('catalog:'))
      .map((tag) => tag.slice('catalog:'.length))
      .filter(Boolean);
    if (assetIds.length === 0) throw new Error(`runtime_asset_identity_missing:${actor.id}`);
    if (assetIds.length !== 1) throw new Error(`runtime_asset_identity_ambiguous:${actor.id}`);
  }
}

function concreteInput(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  ambientMode: AmbientExecutionMode,
  catalogEntries: MaterializeOptions['catalogEntries'],
): ConcreteExecutionInput {
  if (isEmptyScenarioTemplate(template)) return emptyConcreteInput(template, bundle, ambientMode);
  if (template.roles.some((role) => role.kind !== 'scene_absolute')) {
    return portableConcreteInput(template, bundle, ambientMode, catalogEntries);
  }
  if (!template.sourceMap || template.sourceMap.mapId !== bundle.mapId) throw new Error('map_bound_source_mismatch');
  if (!template.anchor.pin || template.anchor.pin.mapId !== bundle.mapId) throw new Error('map_bound_pin_mismatch');
  if (template.anchor.pin.topologyDigest && template.anchor.pin.topologyDigest !== bundle.graph.digest) {
    throw new Error('map_bound_topology_digest_mismatch');
  }
  const runtime = engine();
  // Map-bound documents skip matching: the native compiler binds them at their pinned site.
  const product = compileTemplateWith(runtime.module, template, bundle, null, { drawIndex: -1, catalogEntries });
  const losses = materializationSemanticLosses(product.manifest.notes);
  if (losses.length > 0) throw new Error(`semantic_loss:${JSON.stringify(losses)}`);
  if (!product.manifest.feasible) throw new Error(`materialization_infeasible:${JSON.stringify(product.manifest.issues)}`);
  // The document's Studio content (paint tags, then baked parked cars), by the
  // same native implementation the editor worker applies at the same point.
  const controlled = runtime.studioConcreteInput(withMapControls(product.input, bundle.controlPlan()), template);
  const ambient = runtime.materializeAmbientTraffic(controlled, bundle.graph, executionAmbientProfile(template, ambientMode));
  // The next process on this closure skips the turn probes (timing only).
  void persistAmbientTurnVerdictsToDisk(bundle);
  return {
    input: JSON.parse(ambient.scenario.toJson()) as SimScenarioInput,
    siteId: product.manifest.replayKey.siteId,
    materialization: product.manifest,
    ambientTraffic: ambient.provenance,
  };
}

/**
 * A portable document (roles relative to the scenario's site, as a transfer or a template writes
 * them), executed exactly as the editor's scenario worker previews it
 * (`packages/studio-ui/src/lib/scenario/playback/scenario-worker.ts`): a document pinned to a site
 * on this map compiles at that site; an unpinned one takes the first intent-preserving site, in
 * matcher order, that materializes feasibly without semantic loss. A construct the matcher would
 * have to rewrite, or a pinned site that no longer resolves, is an error, never a silent re-match.
 * Portable documents take the authored paint only; baked parked cars belong to a map-bound
 * document's own map.
 */
function portableConcreteInput(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  ambientMode: AmbientExecutionMode,
  catalogEntries: MaterializeOptions['catalogEntries'],
): ConcreteExecutionInput {
  const runtime = engine();
  const notes = adaptTemplateNotesWith(runtime.module, template);
  if (notes.length > 0) {
    throw new Error(`unsupported_portable_semantics: the matcher would rewrite ${notes.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
  }
  const playable = (product: ReturnType<typeof compileTemplateWith>) => {
    const losses = materializationSemanticLosses(product.manifest.notes);
    if (losses.length > 0) throw new Error(`semantic_loss:${JSON.stringify(losses)}`);
    if (!product.manifest.feasible) throw new Error(`materialization_infeasible:${JSON.stringify(product.manifest.issues)}`);
    return product;
  };
  const pin = template.anchor.pin;
  let product: ReturnType<typeof compileTemplateWith>;
  if (pin?.siteId && pin.mapId === bundle.mapId) {
    let resolved: ReturnType<typeof resolveSiteWith>;
    try {
      resolved = resolveSiteWith(runtime.module, template, bundle, pin.siteId);
    } catch (error) {
      throw new Error(`portable_site_unresolved: site ${pin.siteId} does not match this scenario on ${bundle.mapId} (${error instanceof Error ? error.message : String(error)})`);
    }
    product = selectPlayableSite([resolved.site], () =>
      playable(compileTemplateAtSiteWith(runtime.module, template, bundle, resolved.native, { drawIndex: -1, catalogEntries }))).product;
  } else {
    if (pin?.mapId && pin.mapId !== bundle.mapId) throw new Error('map_bound_pin_mismatch');
    const { report } = matchSitesWith(runtime.module, template, bundle);
    if (!report.sites.some((candidate) => candidate.degradation.intentPreserved)) {
      throw new Error(`portable_site_unresolved: no intent-preserving site matches this scenario on ${bundle.mapId}${report.failureSummary ? ` (${report.failureSummary})` : ''}`);
    }
    product = selectPlayableSite(report.sites, (candidate) =>
      playable(compileTemplateWith(runtime.module, template, bundle, candidate, { drawIndex: -1, catalogEntries }))).product;
  }
  const controlled = runtime.studioConcreteInput(withMapControls(product.input, bundle.controlPlan()), { roles: template.roles });
  const ambient = runtime.materializeAmbientTraffic(controlled, bundle.graph, executionAmbientProfile(template, ambientMode));
  void persistAmbientTurnVerdictsToDisk(bundle);
  return {
    input: JSON.parse(ambient.scenario.toJson()) as SimScenarioInput,
    siteId: product.manifest.replayKey.siteId,
    materialization: product.manifest,
    ambientTraffic: ambient.provenance,
  };
}

/** The ambient profile a concrete input is populated with: the document's own for native traffic, else none. */
function executionAmbientProfile(template: ScenarioTemplateV2, ambientMode: AmbientExecutionMode) {
  return ambientMode === 'native'
    ? ambientTrafficProfileForDocument(template)
    : { version: 1 as const, preset: 'off' as const, seed: 'execution-provider-off' };
}

/**
 * A scenario with no authored actors: the map's blank world, with parked
 * cars and background traffic when the document asks for them. It binds no
 * site. The editor's scenario worker builds the identical input
 * (`emptyScenarioBaseInput`), so the local preview verifies against this.
 */
function emptyConcreteInput(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  ambientMode: AmbientExecutionMode,
): ConcreteExecutionInput {
  if (template.sourceMap && template.sourceMap.mapId !== bundle.mapId) throw new Error('map_bound_source_mismatch');
  if (template.anchor.pin && template.anchor.pin.mapId !== bundle.mapId) throw new Error('map_bound_pin_mismatch');
  const runtime = engine();
  const base = JSON.parse(runtime.studioConcreteInput(
    withMapControls(emptyScenarioBaseInput(bundle.mapId), bundle.controlPlan()),
    template,
  ).toJson()) as SimScenarioInput;
  const ambient = runtime.materializeAmbientTraffic(base, bundle.graph, executionAmbientProfile(template, ambientMode));
  void persistAmbientTurnVerdictsToDisk(bundle);
  const populated = withoutRedundantEmptyScenarioClock({
    input: JSON.parse(ambient.scenario.toJson()) as SimScenarioInput,
    provenance: ambient.provenance,
  });
  return {
    input: populated.input,
    siteId: EMPTY_SCENARIO_SITE_ID,
    materialization: emptyScenarioManifest(bundle.mapId, bundle.graph.digest, base),
    ambientTraffic: populated.provenance,
  };
}

/**
 * The exact input the engine executes — the input AFTER the playback
 * refinements and the engine's own normalize → overlapping-control repair →
 * arrival resolution — as the native world reports it. This is the identity
 * the browser hashed (`manifest.inputHash`), so a raw concrete input would
 * diverge whenever a route crosses a stop-controlled junction (the repair
 * projects stop lines onto the route's connecting lanes). Constructing the
 * world resolves it without running the clip.
 */
function executionResolvedInput(input: SimScenarioInput, graph: LaneGraph): { executed: SimScenarioInput; resolved: SimScenarioInput } {
  const executed = JSON.parse(engine().executionRefinements(input).toJson()) as SimScenarioInput;
  return { executed, resolved: engine().simulation(executed, { graph, captureTrace: false }).input() };
}

/**
 * Resolve a map-bound revision to the input the native engine executes.
 * Declared axis holds that a later exact start preempts are mechanically
 * truncated to the takeover time (runtime-equivalent) before validation; the
 * original template stays canonical for serialization and digests.
 */
export function resolveExecutionInput(
  canonicalContent: unknown,
  map: MapBundle,
  ambientMode: AmbientExecutionMode,
  catalogEntries?: MaterializeOptions['catalogEntries'],
): ResolvedExecutionInput {
  // Stored content keeps the scenarioVersion it was written with: upgrade on read.
  const template = readScenarioDocument(canonicalContent);
  const { template: normalizedTemplate, clamps: axisUntilClamps, report: validation } = clampDeclaredAxisHolds(template);
  if (!validation.ok) throw new Error(`template_invalid:${JSON.stringify(validation.issues)}`);
  const concrete = concreteInput(normalizedTemplate, map, ambientMode, catalogEntries);
  assertRuntimeAssetIdentities(concrete.input);
  const { executed, resolved } = executionResolvedInput(concrete.input, map.graph);
  return { template, axisUntilClamps, concrete, resolvedInput: resolved, executedInput: executed };
}

/** Exact native resolved-input identity shared by the browser and every host. */
export function executionSourceInputDigest(resolvedInput: SimScenarioInput): string {
  return sha256(canonicalJsonBytes(resolvedInput));
}

interface ExportedDocument {
  readonly exported: AsamExportResult;
  readonly bytes: Uint8Array;
  readonly validation: OpenScenarioXml14Validation;
}

async function exportExecutionDocument(
  input: SimScenarioInput,
  resolved: ResolvedExecutionInput,
  request: ExecutionPackageRequest,
  sourceInputDigest: string,
): Promise<ExportedDocument> {
  const preferredRoadsByActor = new Map<string, Set<string>>();
  for (const actor of input.actors) {
    const roads = new Set<string>();
    if (actor.initial.laneRef) roads.add(actor.initial.laneRef.rsl.split(':')[0]!);
    const route = actor.behavior.route;
    if (route.kind === 'lanePath') for (const lane of route.lanes) roads.add(lane.split(':')[0]!);
    if (route.kind === 'follow') roads.add(route.startRsl.split(':')[0]!);
    preferredRoadsByActor.set(actor.id, roads);
  }
  const { template } = resolved;
  const exported = exportOpenScenarioXml14(input, {
    engine: engine(),
    graph: request.map.graph,
    worldElevation: buildXodrElevationResolver(request.xodr, request.map.topology, preferredRoadsByActor),
    roadFile: `${request.map.mapId}.xodr`,
    executionMode: 'trajectory-replay',
    ...(request.simulation ? { replayTrace: request.simulation.trace } : {}),
    trustedAmbientActorIds: resolved.concrete.ambientTraffic.actors.map((actor) => actor.id),
    author: template.meta.author ?? 'SimForge',
    description: template.meta.description || template.meta.name,
    provenance: {
      revisionId: request.revisionId,
      revisionContentSha256: request.expectedContentSha256,
      mapVersionId: request.mapVersionId,
      mapXodrSha256: request.xodrSha256,
      concreteInputSha256: sourceInputDigest,
      inputHash: sourceInputDigest,
      compilerVersion: request.compilerVersion,
    },
  });
  const bytes = new TextEncoder().encode(exported.content);
  if (bytes.byteLength > MAX_EXECUTION_XOSC_BYTES) throw new Error('compiled_xosc_too_large');
  const validation = await (request.validateXml ?? validateOpenScenarioXml14)(exported.content, request.xsdPath);
  if (!validation.valid) throw new Error(`xosc_xsd_invalid:${JSON.stringify(validation.diagnostics)}`);
  return { exported, bytes, validation };
}

interface ProjectionRecord {
  readonly artifactKind: string;
  /** The XOSC a consumer of this projection loads: its own artifact, or the canonical one. */
  readonly xoscSha256: string;
  readonly projected: boolean;
  readonly warnings: readonly AsamExportWarning[];
  readonly [key: string]: unknown;
}

/**
 * Compile a claimed revision into its execution package. Every host-claimed
 * identity (content digest, ambient config, materialized-traffic source
 * input) is verified against what this compilation reproduces before any
 * artifact is assembled.
 */
export async function compileExecutionPackage(request: ExecutionPackageRequest): Promise<ExecutionPackage> {
  const runtimeMapName = request.runtimeMapName.trim();
  if (!runtimeMapName) throw new Error('runtime_map_identity_missing');
  const { ambient } = request;
  const resolved = request.simulation
    ? resolutionFromSimulation(request.canonicalContent, request.simulation)
    : resolveExecutionInput(request.canonicalContent, request.map, ambient.mode, request.catalogEntries);
  const canonicalBytes = new TextEncoder().encode(serializeTemplate(resolved.template));
  if (sha256(canonicalBytes) !== request.expectedContentSha256) throw new Error('revision_content_digest_mismatch');
  if (sha256(canonicalJsonBytes(ambient.ambientConfig)) !== ambient.configSha256) {
    throw new Error('ambient_config_digest_mismatch');
  }
  if (ambient.mode === 'disabled' && ambient.configSha256 !== EMPTY_AMBIENT_CONFIG_SHA256) {
    throw new Error('disabled_ambient_provenance_mismatch');
  }
  const sourceInputDigest = executionSourceInputDigest(resolved.resolvedInput);
  if (ambient.materializedTraffic.sourceInputDigest !== sourceInputDigest) {
    // The claimed digest comes from the producer's own resolution (the editor's
    // saved simulation, or the CLI's upload of it); this one comes from the map
    // closure the compiler resolves against. Nothing binds those two closures,
    // so name both digests and the ambient mode that produced them - a bare
    // code sends the reader looking for a stuck job instead of a disagreement.
    //
    // Name this engine build too. The producer is the WASM build and this is
    // the N-API addon, and `engineVersion`/`abiVersion` are identical in both
    // by construction: an addon that predates a serialization change resolves
    // every authored document to a different input while reporting the exact
    // identity the browser reports. Without the addon digest here, that reads
    // as a content or map-closure disagreement and costs a day to find.
    const resolvedBy = runtimeIdentity();
    throw new Error(`materialized_traffic_source_input_digest_mismatch: claimed ${ambient.materializedTraffic.sourceInputDigest}, resolved ${sourceInputDigest} (ambient ${ambient.mode}, map ${runtimeMapName}, resolved by engine ${resolvedBy.engineVersion} abi ${resolvedBy.abiVersion} addon ${resolvedBy.addonSha256.slice(0, 12)})`);
  }

  const canonical = await exportExecutionDocument(resolved.resolvedInput, resolved, request, sourceInputDigest);
  const xosc = artifact('xosc', 'application/xml', canonical.bytes);

  const projectionArtifacts: ExecutionArtifact[] = [];
  const projections: Record<string, ProjectionRecord> = {};
  for (const [name, projection] of Object.entries(request.projections ?? {})) {
    const { input, provenance } = projection.project(resolved);
    if (input === null) {
      projections[name] = { ...provenance, artifactKind: projection.artifactKind, xoscSha256: xosc.sha256, projected: false, warnings: [] };
      continue;
    }
    const document = await exportExecutionDocument(input, resolved, request, sourceInputDigest);
    const projected = artifact(projection.artifactKind, 'application/xml', document.bytes);
    projectionArtifacts.push(projected);
    projections[name] = {
      ...provenance,
      artifactKind: projection.artifactKind,
      xoscSha256: projected.sha256,
      projected: true,
      warnings: document.exported.warnings,
    };
  }

  const overlapActorIds = resolved.concrete.ambientTraffic.actors.map((actor) => actor.id).sort();
  const capability = {
    contract: CAPABILITY_REPORT_CONTRACT,
    openScenario: canonical.exported.capabilityReport,
    warnings: canonical.exported.warnings,
    validation: canonical.validation,
  };
  const provenance = {
    contract: COMPILER_PROVENANCE_CONTRACT,
    compilerVersion: request.compilerVersion,
    runtimeContractVersion: EXECUTION_PACKAGE_CONTRACT,
    revisionId: request.revisionId,
    revisionContentSha256: request.expectedContentSha256,
    mapVersionId: request.mapVersionId,
    runtimeMapName,
    mapArtifactDigests: request.mapArtifactDigests,
    coordinateSystemId: request.coordinateSystemId,
    coordinateSystemSha256: request.coordinateSystemSha256,
    assetCatalogVersionId: request.assetCatalogVersionId,
    assetCatalogManifestSha256: request.assetCatalogManifestSha256,
    ambient,
    siteId: resolved.concrete.siteId,
    concreteInputSha256: sourceInputDigest,
    sourceInputDigest,
    materializedTrafficDigest: ambient.materializedTraffic.sha256,
    materializedTrafficOverlapActorIds: overlapActorIds,
    // The cross-engine digest the browser evidence records as well, so both records agree.
    ambientTraffic: { ...resolved.concrete.ambientTraffic, generatedInputHash: sourceInputDigest },
    materialization: resolved.concrete.materialization,
    axisUntilClamps: resolved.axisUntilClamps,
    projections,
    simulation: request.simulation ? { simKey: request.simulation.simKey, traceSha256: request.simulation.traceSha256 } : null,
  };
  const preliminary = [
    xosc,
    artifact('capability-report', 'application/json', canonicalJsonBytes(capability)),
    artifact('compiler-provenance', 'application/json', canonicalJsonBytes(provenance)),
    ...projectionArtifacts,
  ];
  const manifest = {
    contract: EXECUTION_PACKAGE_CONTRACT,
    openScenarioProfile: EXECUTION_OPENSCENARIO_PROFILE,
    xsdSha256: OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256,
    revision: { id: request.revisionId, sha256: request.expectedContentSha256 },
    sourceInputDigest,
    materializedTrafficDigest: ambient.materializedTraffic.sha256,
    map: {
      assetId: request.mapAssetId,
      versionId: request.mapVersionId,
      id: request.mapVersionId,
      runtimeMapName,
      xodrSha256: request.xodrSha256,
      artifacts: request.mapArtifactDigests,
    },
    assetCatalog: { versionId: request.assetCatalogVersionId, manifestSha256: request.assetCatalogManifestSha256 },
    ambient,
    materializedTraffic: {
      artifactId: ambient.materializedTraffic.artifactId,
      sha256: ambient.materializedTraffic.sha256,
      sizeBytes: ambient.materializedTraffic.sizeBytes,
      overlapActorIds,
    },
    projections,
    // The trace every renderer replays; the XOSC above is derived from it.
    ...(request.simulation ? { simKey: request.simulation.simKey, traceSha256: request.simulation.traceSha256 } : {}),
    files: preliminary.map((item) => ({ kind: item.kind, mediaType: item.mediaType, sha256: item.sha256, sizeBytes: item.bytes.byteLength })),
  };
  const manifestArtifact = artifact('execution-manifest', 'application/json', canonicalJsonBytes(manifest));
  return {
    artifacts: [...preliminary, manifestArtifact],
    manifestSha256: manifestArtifact.sha256,
    xsdSha256: OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256,
    sourceInputDigest,
  };
}
