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
  ambientTrafficProfileFromExtensions,
  canonicalJson,
  type AmbientTrafficProvenance,
  type LaneGraph,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import { exportOpenScenarioXml14, type AsamExportResult, type AsamExportWarning } from '@simforge-oss/openscenario';
import {
  OFFICIAL_OPENSCENARIO_140_XSD,
  validateOpenScenarioXml14,
  type OpenScenarioXml14Validation,
} from '@simforge-oss/openscenario/node';
import { withBoundedSpeedCruiseRestoration, withStableHighSpeedWorldRoutes } from '@simforge-oss/playback';
import { parseTemplate, serializeTemplate, type ScenarioTemplateV2 } from '@simforge-oss/scenario';

import type { MapControlPlan } from './map-signals.js';
import { compileTemplateWith, materializationSemanticLosses, type MaterializeOptions } from './materialize.js';
import { withStudioBodyColorTags } from './studio/body-color.js';
import { bakedParkedCarsFromExtensions, withParkedCarActors } from './studio/parked-cars.js';
import { clampDeclaredAxisHolds, type AxisUntilClamp } from './template-axis-clamp.js';
import type { MapBundle } from './types.js';
import { buildXodrElevationResolver } from './xodr-elevation.js';

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
}

/**
 * Host-side canonicalization of the resolved input before it is digested.
 * Local hashes the raw resolved input, exactly as the native trace header
 * does; Cloud collapses cross-engine transcendental noise first. The digest
 * is a host ↔ browser contract, so the host names its own canonicalization.
 */
export type DigestCanonicalization = (input: SimScenarioInput) => unknown;

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
  readonly digestCanonicalization?: DigestCanonicalization | undefined;
  readonly projections?: Readonly<Record<string, ExecutionProjection>> | undefined;
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
  if (template.roles.length === 0 || template.roles.some((role) => role.kind !== 'scene_absolute')) {
    throw new Error('unsupported_portable_semantics');
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
  // Applied at the same points the browser worker applies them, so the concrete
  // input digests agree. Paint tags come first (the browser stamps them before
  // parked cars on the map-bound path); a document with no authored paint and
  // no baked cars is untouched.
  const controlled = withParkedCarActors(
    withStudioBodyColorTags(withMapControls(product.input, bundle.controlPlan()), template),
    bakedParkedCarsFromExtensions(template.extensions),
  );
  const ambient = runtime.materializeAmbientTraffic(
    controlled,
    bundle.graph,
    ambientMode === 'native'
      ? ambientTrafficProfileFromExtensions(template.extensions)
      : { version: 1, preset: 'off', seed: 'execution-provider-off' },
  );
  return {
    input: JSON.parse(ambient.scenario.toJson()) as SimScenarioInput,
    siteId: product.manifest.replayKey.siteId,
    materialization: product.manifest,
    ambientTraffic: ambient.provenance,
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
function executionResolvedInput(input: SimScenarioInput, graph: LaneGraph): SimScenarioInput {
  const refined = withBoundedSpeedCruiseRestoration(withStableHighSpeedWorldRoutes(input));
  return engine().simulation(refined, { graph, captureTrace: false }).input();
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
  const template = parseTemplate(canonicalContent);
  const { template: normalizedTemplate, clamps: axisUntilClamps, report: validation } = clampDeclaredAxisHolds(template);
  if (!validation.ok) throw new Error(`template_invalid:${JSON.stringify(validation.issues)}`);
  const concrete = concreteInput(normalizedTemplate, map, ambientMode, catalogEntries);
  assertRuntimeAssetIdentities(concrete.input);
  const resolvedInput = executionResolvedInput(concrete.input, map.graph);
  return { template, axisUntilClamps, concrete, resolvedInput };
}

/**
 * The revision's source-input digest: sha256 of the canonical JSON of the
 * resolved input, after the host's digest canonicalization. The resolved
 * input itself is never quantized; only the bytes being digested are.
 */
export function executionSourceInputDigest(
  resolvedInput: SimScenarioInput,
  canonicalize: DigestCanonicalization = (input) => input,
): string {
  return sha256(canonicalJsonBytes(canonicalize(resolvedInput)));
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
  const resolved = resolveExecutionInput(request.canonicalContent, request.map, ambient.mode, request.catalogEntries);
  const canonicalBytes = new TextEncoder().encode(serializeTemplate(resolved.template));
  if (sha256(canonicalBytes) !== request.expectedContentSha256) throw new Error('revision_content_digest_mismatch');
  if (sha256(canonicalJsonBytes(ambient.ambientConfig)) !== ambient.configSha256) {
    throw new Error('ambient_config_digest_mismatch');
  }
  if (ambient.mode === 'disabled' && ambient.configSha256 !== EMPTY_AMBIENT_CONFIG_SHA256) {
    throw new Error('disabled_ambient_provenance_mismatch');
  }
  const sourceInputDigest = executionSourceInputDigest(resolved.resolvedInput, request.digestCanonicalization);
  if (ambient.materializedTraffic.sourceInputDigest !== sourceInputDigest) {
    throw new Error('materialized_traffic_source_input_digest_mismatch');
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
