import type { AppContext } from "@/app/lib/db/app-context";
import { activeNativeGpuCapacities, knownNativeSceneDemand, NATIVE_GPU_HEADROOM_BYTES, NativeSceneMemoryError } from "./workers-prewarm-store";
import { withTransaction } from "@/app/lib/db/data-api";
import { hashRenderIntent, PRONTO_CHASE_CAMERA_SENSOR, PRONTO_CHASE_CAMERA_SENSOR_ID, RENDER_INTENT_V1_SCHEMA, type RenderSpecV3 } from "@simforge-oss/scenario";
import { NATIVE_ACTOR_ASSETS_INPUT_ID, NATIVE_TEXTURE_DENSITY_MANIFEST, nativeActorAssetsInput, assertNativeMapMemberCapacity } from "@simforge-oss/render/native";
import { RENDER_TIMELINE_INPUT_ID } from "@simforge-oss/render/timeline";
import { canonicalJsonSha256, scenarioId, sha256 } from "./core";
import { boundMapDerivatives, derivativeMembers, MAP_DERIVATIVE_DESCRIPTOR_SQL, MAP_DERIVATIVE_MEMBERS_JOIN_SQL, mapDerivativeExtraMembers, type MapDerivativeMemberRow } from "./map-derivatives";
import type { ScenarioRenderJobDto } from "./contracts";
import { nativeMapMemberAsset, storedRenderIntent, type NativeClosureAsset } from "./render-intent-closure";
import type { ScenarioMotionSource, ScenarioTimelineContactOrigin } from "@simforge-oss/studio-host";
import {
  ScenarioRenderIntentSchema,
  type SubmitScenarioRenderIntent,
  type ScenarioRenderIntent,
} from "./render-wire-contracts";
import { simforgeEnv } from "@/lib/simforge-env";

const RTX5080_MAX_SIMULTANEOUS_SOURCES = 18;
const RTX5080_USABLE_GPU_BYTES = 15_000 * 1024 * 1024;

type ImmutableLineageRow = {
  revision_id: string;
  scenario_sha256: string;
  canonical_content: string | Record<string, unknown>;
  execution_package_id: string;
  source_input_digest: string;
  xosc_sha256: string;
  xosc_size: number;
  map_id: string;
  map_revision_id: string;
  map_sha256: string;
  map_artifact_id: string;
  map_size: number;
  catalog_artifact_id: string;
  catalog_sha256: string;
  catalog_size: number;
};

/**
 * One native intent asset: a map closure member (`map.tile.000000` /
 * `map.resource.<sha256(path)>`) or the actor closure (`actors.native-closure`).
 * Every one is declared by digest so the intent hash binds the served bytes.
 */
type NativeAsset = {
  assetId: string;
  kind: "map" | "catalog" | "other";
  sha256: string;
  sizeBytes: number;
};

type NativeMapMemberRow = {
  asset_set_id?: string;
  relative_path: string;
  sha256: string;
  byte_length: number | string;
  object_count: number | string;
};

type InsertedJob = {
  id: string;
  revision_id: string;
  execution_package_id: string;
  job_mode: "browser_render" | "full_render";
  job_state: ScenarioRenderJobDto["status"];
  progress: number;
  sim_key: string | null;
  trace_sha256: string | null;
  timeline_sha256: string | null;
  motion_source?: ScenarioMotionSource | null;
  timeline_contact_origin?: string | null;
  created_at: string;
  updated_at: string;
};

export type RenderResourceRequestV2 = {
  schema: "uniscenario.render-resource-request/v2";
  durationSeconds: number;
  simultaneousSources: number;
  modalities: Record<string, number>;
  cameraPixelsPerFrame: number;
  maxWidth: number;
  maxHeight: number;
  framesPerSecond: number;
  estimatedGpuBytes: number;
  estimatedOutputBytes: number;
};

function cameraAttributes(source: RenderSpecV3["sources"][number]) {
  return source.modality === "rgb"
    || source.modality === "depth"
    || source.modality === "semantic"
    || source.modality === "instance"
    ? source.attributes
    : null;
}

/**
 * Members of a map version's bound derivative sets (map-derivatives.ts) that
 * its native closure does not already carry, and the ids of those sets. A
 * binding whose set is incomplete is a broken backfill and fails the
 * submission.
 */
async function boundDerivativeMembers(
  tx: { queryRows<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> },
  mapVersionId: string,
  closurePaths: ReadonlySet<string>,
): Promise<{ setIds: string[]; members: NativeMapMemberRow[] }> {
  const [row] = await tx.queryRows<{ derivatives: unknown }>(
    `SELECT ${MAP_DERIVATIVE_DESCRIPTOR_SQL} AS derivatives FROM simforge.map_versions mv WHERE mv.id = :map_version_id`,
    { map_version_id: mapVersionId },
  );
  const bindings = boundMapDerivatives(row?.derivatives);
  if (bindings.length === 0) return { setIds: [], members: [] };
  const rows = await tx.queryRows<MapDerivativeMemberRow>(
    `SELECT ds.id AS set_id, dm.relative_path, db.sha256, db.byte_length
       FROM simforge.map_versions mv ${MAP_DERIVATIVE_MEMBERS_JOIN_SQL}
      WHERE mv.id = :map_version_id
      ORDER BY dm.relative_path`,
    { map_version_id: mapVersionId },
  );
  return {
    setIds: bindings.map((binding) => binding.assetSetId),
    members: mapDerivativeExtraMembers(derivativeMembers(bindings, rows), closurePaths)
      .map((member) => ({ relative_path: member.relativePath, sha256: member.sha256, byte_length: member.byteLength, object_count: 0 })),
  };
}

export function deriveRenderIntentResources(spec: RenderSpecV3): RenderResourceRequestV2 {
  const durationSeconds = spec.clip.endSeconds - spec.clip.startSeconds;
  const modalities: Record<string, number> = {};
  const physicalSensors = new Set(spec.sources.map((source) => `${source.actorId}\0${source.sensorId}`));
  let cameraPixelsPerFrame = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  let framesPerSecond = spec.video?.fps ?? 1;
  let estimatedGpuBytes = 0;
  let estimatedOutputBytes = 0;
  for (const source of spec.sources) {
    modalities[source.modality] = (modalities[source.modality] ?? 0) + 1;
    const camera = cameraAttributes(source);
    if (camera) {
      const pixels = camera.width * camera.height;
      const bytesPerPixel = source.modality === "rgb" ? 4 : 8;
      cameraPixelsPerFrame += pixels;
      maxWidth = Math.max(maxWidth, camera.width);
      maxHeight = Math.max(maxHeight, camera.height);
      framesPerSecond = Math.max(framesPerSecond, camera.fps);
      estimatedGpuBytes += pixels * bytesPerPixel * 3;
      estimatedOutputBytes += pixels * bytesPerPixel * camera.fps * durationSeconds;
    } else if (source.modality === "lidar") {
      estimatedGpuBytes += 256 * 1024 * 1024;
      estimatedOutputBytes += source.attributes.pointsPerSecond * 24 * durationSeconds;
    } else if (source.modality === "radar") {
      estimatedGpuBytes += 64 * 1024 * 1024;
      estimatedOutputBytes += source.attributes.pointsPerSecond * 32 * durationSeconds;
    }
  }
  return {
    schema: "uniscenario.render-resource-request/v2",
    durationSeconds,
    simultaneousSources: physicalSensors.size,
    modalities,
    cameraPixelsPerFrame,
    maxWidth,
    maxHeight,
    framesPerSecond,
    estimatedGpuBytes,
    estimatedOutputBytes: Math.ceil(estimatedOutputBytes),
  };
}

function enforceRtx5080Admission(resources: RenderResourceRequestV2) {
  if (resources.simultaneousSources > RTX5080_MAX_SIMULTANEOUS_SOURCES) {
    throw new Error("uniscenario_render_resource_maxSimultaneousSensors_exceeded");
  }
  if (resources.estimatedGpuBytes > RTX5080_USABLE_GPU_BYTES) {
    throw new Error("uniscenario_render_resource_gpuMemory_exceeded");
  }
}

function selectedSensorHosts(input: SubmitScenarioRenderIntent, lineage: ImmutableLineageRow) {
  const content = typeof lineage.canonical_content === "string"
    ? JSON.parse(lineage.canonical_content) as Record<string, unknown>
    : lineage.canonical_content;
  const roles = Array.isArray(content.roles) ? content.roles : [];
  const selectedActorIds = new Set(input.renderSpec.sources.map((source) => source.actorId));
  const selectedSourceKeys = new Set(
    input.renderSpec.sources.map((source) => `${source.actorId}\0${source.sensorId}\0${source.modality}`),
  );
  const foundActorIds = new Set<string>();
  const foundSourceKeys = new Set<string>();
  const catalogIdByActor = new Map<string, string>();
  for (const role of roles) {
    if (!role || typeof role !== "object") continue;
    const value = role as {
      id?: unknown;
      actor?: { catalogId?: unknown; sensors?: unknown[] };
    };
    if (typeof value.id !== "string" || !selectedActorIds.has(value.id)) continue;
    if (typeof value.actor?.catalogId !== "string" || !value.actor.catalogId.trim()) {
      throw new Error(`render_sensor_host_asset_missing:${value.id}`);
    }
    foundActorIds.add(value.id);
    catalogIdByActor.set(value.id, value.actor.catalogId);
    // The platform's trailing chase camera is authored by the render contract,
    // not the document: a source with its id is admitted only against the
    // canonical mount, unless the actor authors its own.
    const authoredSensors = [...(value.actor.sensors ?? [])];
    if (!authoredSensors.some((sensor) => (sensor as { id?: unknown } | null)?.id === PRONTO_CHASE_CAMERA_SENSOR_ID)) {
      authoredSensors.push(PRONTO_CHASE_CAMERA_SENSOR);
    }
    for (const authoredSensor of authoredSensors) {
      if (!authoredSensor || typeof authoredSensor !== "object") continue;
      const sensor = authoredSensor as {
        id?: unknown;
        type?: unknown;
        mount?: unknown;
      };
      if (typeof sensor.id !== "string") continue;
      const selectedSources = input.renderSpec.sources.filter(
        (source) => source.actorId === value.id && source.sensorId === sensor.id,
      );
      for (const selected of selectedSources) {
        const modalityMatches = sensor.type === "dash_camera"
          ? ["rgb", "depth", "semantic", "instance"].includes(selected.modality)
          : sensor.type === "lidar"
            ? selected.modality === "lidar"
            : sensor.type === "radar" && selected.modality === "radar";
        if (!modalityMatches || canonicalJsonSha256(sensor.mount) !== canonicalJsonSha256(selected.transform)) {
          throw new Error(`render_sensor_source_mismatch:${value.id}:${sensor.id}`);
        }
        foundSourceKeys.add(`${value.id}\0${sensor.id}\0${selected.modality}`);
      }
    }
  }
  if (foundActorIds.size !== selectedActorIds.size || foundSourceKeys.size !== selectedSourceKeys.size) {
    throw new Error("render_sensor_host_asset_lineage_incomplete");
  }
  return input.renderSpec.sources.map((source) => ({
    sourceId: source.outputName,
    actorId: source.actorId,
    vehicleAsset: { catalogAssetId: catalogIdByActor.get(source.actorId)! },
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

/**
 * The render seed. A document with a pinned `simulation.seed` derives it from
 * that seed alone, so a rename or a save (which change `content_sha256` through
 * `meta.modifiedAt`) no longer changes it. A revision frozen before pinning
 * keeps its legacy seed, the first 32 bits of its content digest, so its
 * renders stay reproducible.
 */
export function renderSeed(content: Record<string, unknown>, scenarioSha256: string): number {
  const simulation = content["simulation"];
  const pinned = simulation && typeof simulation === "object" ? (simulation as { seed?: unknown }).seed : undefined;
  const digest = typeof pinned === "string" && pinned.length > 0
    ? sha256(`simforge.render-seed/v1|${pinned}`)
    : scenarioSha256;
  return Number.parseInt(digest.slice(0, 8), 16);
}

/** A submit-time refusal the route reports as `render_intent_invalid` with its reason. */
function renderIntentRefusal(code: string, message: string): Error & { detail: string } {
  return Object.assign(new Error(code), { detail: message });
}

/**
 * CARLA renders any window of the frozen clip by trace replay, seeking to its
 * start exactly as the native engine does (`simforge-oss-carla-exec`
 * `resolve_render_window`). What it cannot render exactly is refused here,
 * at submit, with the reason, never discovered by the worker at run time and
 * never widened to the full clip.
 */
export function assertCarlaRenderClip(spec: RenderSpecV3, clipSeconds: number): void {
  const { startSeconds, endSeconds } = spec.clip;
  const window = endSeconds - startSeconds;
  if (window < 0.02) {
    throw renderIntentRefusal(
      "carla_render_clip_too_short",
      `CARLA renders on a 0.02 s tick; the ${startSeconds}-${endSeconds} s clip is shorter than one tick.`,
    );
  }
  // Physics validation integrates CARLA physics from the authored start and
  // grades every authored contact, so it renders only the whole clip; the
  // (default) trace replay renders any window of it.
  if (
    spec.capabilityIntent.required.includes("actor.native_controls")
    && (startSeconds > 0 || endSeconds < clipSeconds)
  ) {
    throw renderIntentRefusal(
      "carla_render_clip_physics_validation_partial",
      `CARLA physics validation (actor.native_controls) renders the whole ${clipSeconds} s clip, not ${startSeconds}-${endSeconds} s.`,
    );
  }
  // CARLA captures every sensor at the video rate, else the first camera's.
  const camera = spec.sources.find((source) => source.modality !== "lidar" && source.modality !== "radar");
  const fps = spec.video?.fps ?? (camera && "fps" in camera.attributes ? camera.attributes.fps : undefined);
  if (fps === undefined) return;
  const frames = window * fps;
  if (Math.abs(frames - Math.round(frames)) > 1e-6) {
    throw renderIntentRefusal(
      "carla_render_clip_frame_count_fractional",
      `CARLA renders a whole number of frames: ${window} s at ${fps} fps is ${Number(frames.toFixed(3))} frames.`,
    );
  }
}

function buildIntent(
  input: SubmitScenarioRenderIntent,
  lineage: ImmutableLineageRow,
  nativeAssets: readonly NativeAsset[],
  fleetGpuBytes?: number,
): ScenarioRenderIntent {
  const content = typeof lineage.canonical_content === "string"
    ? JSON.parse(lineage.canonical_content) as Record<string, unknown>
    : lineage.canonical_content;
  // The wizard renders a prefix of the frozen clip: the intent must start at
  // the scenario origin and end inside the authored choreography, otherwise
  // the schedule would ask the engine for ticks the revision never verified.
  const clipSeconds = (content.choreography as { clipSeconds?: unknown } | undefined)?.clipSeconds;
  if (
    typeof clipSeconds !== "number"
    || input.renderSpec.clip.startSeconds !== 0
    || input.renderSpec.clip.endSeconds <= 0
    || input.renderSpec.clip.endSeconds > clipSeconds
  ) {
    throw new Error("pronto_render_clip_out_of_bounds");
  }
  if (
    input.engine === "native"
    && input.renderSpec.video
    && (
      input.renderSpec.video.container !== "mp4"
      || input.renderSpec.video.codec !== "h264"
    )
  ) {
    throw new Error("native_render_video_format_invalid");
  }
  const sensorHosts = selectedSensorHosts(input, lineage);
  if (
    input.engine === "carla"
    && input.renderSpec.video
    && (
      input.renderSpec.video.container !== "mp4"
      || input.renderSpec.video.codec !== "h264"
    )
  ) {
    throw new Error("carla_render_video_format_invalid");
  }
  if (input.engine === "carla") assertCarlaRenderClip(input.renderSpec, clipSeconds);
  const intentId = scenarioId("usri");
  return ScenarioRenderIntentSchema.parse({
    schema: RENDER_INTENT_V1_SCHEMA,
    intentId,
    executionPackage: {
      id: lineage.execution_package_id,
      sourceInputDigest: lineage.source_input_digest,
    },
    scenarioRevision: {
      revisionId: lineage.revision_id,
      scenarioSha256: lineage.scenario_sha256,
      openScenario: { sha256: lineage.xosc_sha256, sizeBytes: Number(lineage.xosc_size) },
      map: {
        mapId: lineage.map_id,
        revisionId: lineage.map_revision_id,
        sha256: lineage.map_sha256,
      },
    },
    sensorHosts,
    renderSpec: input.renderSpec,
    ...(input.engine === "native" ? {
      renderTextures: nativeRenderTextureTier(input.renderProfile, input.renderSpec.sources),
      // The fleet's real device size when known (largest active native worker), not an assumed 16 GiB.
      nativeVramCapacityBytes: input.nativeVramBudgetBytes ?? fleetGpuBytes ?? 16 * 1024 ** 3,
      ...(input.nativeVramBudgetBytes === undefined ? {} : { nativeVramBudgetBytes: input.nativeVramBudgetBytes }),
    } : {}),
    assets: [
      {
        assetId: lineage.map_artifact_id,
        kind: "map",
        sha256: lineage.map_sha256,
        sizeBytes: Number(lineage.map_size),
      },
      {
        assetId: lineage.catalog_artifact_id,
        kind: "catalog",
        sha256: lineage.catalog_sha256,
        sizeBytes: Number(lineage.catalog_size),
      },
      ...nativeAssets,
    ],
    seed: renderSeed(content, lineage.scenario_sha256),
    ...(input.motionSource ? { motionSource: input.motionSource } : {}),
  });
}

/**
 * The native texture tier a render intent pins. `ml` renders always use the
 * 512 px BC7 variants. Otherwise the policy (`SIMFORGE_NATIVE_TEXTURE_TIER_POLICY`)
 * decides: `profile` (default, the historical behaviour) always renders full
 * UASTC; `resolution` uses the 512 px variants when every camera is below
 * `SIMFORGE_NATIVE_FULL_TEXTURE_MIN_HEIGHT` (default 720) rows, where full-size
 * textures cannot resolve anyway and cost ~5x the download and VRAM.
 * A quality tradeoff: the user decides before `resolution` becomes default.
 */
export function nativeRenderTextureTier(
  renderProfile: string | undefined,
  sources: readonly { modality: string; attributes: unknown }[],
  env: NodeJS.ProcessEnv = process.env,
): "uastc-full" | "bc7-512" {
  if (renderProfile === "ml") return "bc7-512";
  if (env.SIMFORGE_NATIVE_TEXTURE_TIER_POLICY?.trim() !== "resolution") return "uastc-full";
  const minHeight = Number(env.SIMFORGE_NATIVE_FULL_TEXTURE_MIN_HEIGHT ?? 720);
  const heights = sources
    .filter((source) => source.modality === "rgb")
    .map((source) => Number((source.attributes as { height?: number }).height ?? Infinity));
  return heights.length > 0 && heights.every((height) => height < minHeight) ? "bc7-512" : "uastc-full";
}

export async function createRenderIntentJob(
  context: Pick<AppContext, "workspaceId" | "userId">,
  input: SubmitScenarioRenderIntent,
  /**
   * The revision's authoritative simulation (resolved by the caller): the job
   * records the trace and render timeline every renderer replays.
   */
  simulation: {
    simKey: string;
    traceSha256: string;
    timelineSha256: string | null;
    timelineSizeBytes: number | null;
    engineSemVer?: string;
    /** Where the replayed timeline's heights came from; `legacy-xodr-elevation` is shown on the job. */
    timelineContactOrigin?: "trace" | "derived-at-timeline-build" | "legacy-xodr-elevation" | null;
  } | null = null,
  /** Which motion the render replays (`render_jobs.motion_source`). */
  motionSource: ScenarioMotionSource | null = null,
): Promise<ScenarioRenderJobDto | null> {
  const renderSpec = input.renderSpec;
  const resources = deriveRenderIntentResources(renderSpec);
  enforceRtx5080Admission(resources);
  const inserted = await withTransaction(async (tx) => {
    await tx.queryOne(`SELECT pg_advisory_xact_lock(hashtext(:workspace_id)) AS locked`, {
      workspace_id: context.workspaceId,
    });
    const existing = await tx.queryOne<InsertedJob & { intent_sha256: string; renderer_engine: string; render_spec_sha256: string; render_textures: string | null; native_vram_budget: string | null }>(
      `SELECT id, revision_id, execution_package_id, job_mode, job_state, progress,
              sim_key, trace_sha256, timeline_sha256, motion_source,
              intent_sha256, renderer_engine, render_spec_sha256,
              render_intent->>'renderTextures' AS render_textures,
              render_intent->>'nativeVramBudgetBytes' AS native_vram_budget,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM simforge.render_jobs
        WHERE workspace_id = :workspace_id AND idempotency_key = :idempotency_key
        LIMIT 1`,
      { workspace_id: context.workspaceId, idempotency_key: input.idempotencyKey },
    );
    if (existing) {
      if (existing.revision_id !== input.revisionId
        || existing.execution_package_id !== input.executionPackageId
        || existing.renderer_engine !== input.engine
        || (input.engine === "native" && existing.render_textures !== nativeRenderTextureTier(input.renderProfile, renderSpec.sources))
        || (input.engine === "native" && (existing.native_vram_budget === null ? undefined : Number(existing.native_vram_budget)) !== input.nativeVramBudgetBytes)
        || existing.render_spec_sha256 !== canonicalJsonSha256(renderSpec)
        || (existing.motion_source ?? null) !== motionSource
        || (existing.sim_key ?? null) !== (simulation?.simKey ?? null)) {
        throw new Error("uniscenario_render_intent_idempotency_conflict");
      }
      return existing;
    }
    const counts = await tx.queryOne<{ active_count: number; queued_count: number }>(
      `SELECT COUNT(*) FILTER (WHERE job_state IN ('leased', 'running'))::int AS active_count,
              COUNT(*) FILTER (WHERE job_state = 'queued')::int AS queued_count
         FROM simforge.render_jobs WHERE workspace_id = :workspace_id`,
      { workspace_id: context.workspaceId },
    );
    const activeLimit = Math.max(1, Number(simforgeEnv("WORKSPACE_CONCURRENCY_LIMIT") ?? 2));
    const queueLimit = Math.max(activeLimit, Number(simforgeEnv("WORKSPACE_QUEUE_LIMIT") ?? 20));
    if (Number(counts?.active_count ?? 0) >= activeLimit || Number(counts?.queued_count ?? 0) >= queueLimit) {
      throw new Error("uniscenario_workspace_limit_reached");
    }
    const lineage = await tx.queryOne<ImmutableLineageRow>(
      `SELECT r.id AS revision_id, r.content_sha256 AS scenario_sha256,
              r.canonical_content::text AS canonical_content,
              ep.id AS execution_package_id, ep.source_input_digest,
              xosc.sha256 AS xosc_sha256, xosc.byte_length AS xosc_size,
              COALESCE(NULLIF(mv.source_map_id, ''), mv.id) AS map_id,
              mv.id AS map_revision_id, xodr.sha256 AS map_sha256,
              xodr.id AS map_artifact_id, xodr.byte_length AS map_size,
              catalog_artifact.id AS catalog_artifact_id,
              catalog_artifact.sha256 AS catalog_sha256,
              catalog_artifact.byte_length AS catalog_size
         FROM simforge.revisions r
         JOIN simforge.execution_packages ep
           ON ep.revision_id = r.id AND ep.workspace_id = r.workspace_id
         JOIN simforge.map_versions mv ON mv.id = r.map_version_id
         JOIN simforge.artifacts xosc
           ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
          AND xosc.artifact_state = 'available'
         JOIN simforge.artifacts xodr
           ON xodr.id = ep.xodr_artifact_id AND xodr.artifact_state = 'available'
         JOIN simforge.asset_catalog_versions catalog
           ON catalog.id = ep.asset_catalog_version_id
         JOIN simforge.artifacts catalog_artifact
           ON catalog_artifact.id = catalog.manifest_artifact_id
          AND catalog_artifact.artifact_state = 'available'
        WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
          AND ep.id = :execution_package_id
          AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
          AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
          AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
        LIMIT 1 FOR SHARE OF ep`,
      {
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
      },
    );
    if (!lineage) return null;
    let nativeAssets: NativeAsset[] = [];
    // The map members the native intent declares, stored by reference to the
    // sets they come from (render-intent-closure.ts), not inline.
    let nativeClosure: { nativeMapAssetSetId: string; derivativeSetIds: string[]; members: NativeClosureAsset[] } | null = null;
    let fleetGpuBytes: number | undefined;
    if (input.engine === "native") {
      const fleet = await activeNativeGpuCapacities(tx);
      fleetGpuBytes = fleet.length > 0 ? Math.max(...fleet) : undefined;
      const nativeMembers = await tx.queryRows<NativeMapMemberRow>(
        `SELECT s.id AS asset_set_id, m.relative_path, b.sha256, b.byte_length, s.object_count
           FROM simforge.map_versions mv
           JOIN simforge.native_map_asset_sets s
             ON s.id = mv.native_map_asset_set_id
            AND s.workspace_id = mv.workspace_id
            AND s.map_version_id = mv.id
            AND s.asset_set_state = 'available'
            AND s.contract_version = 'simforge.native-map-asset-set.v1'
            AND s.registry_release_digest = mv.descriptor->>'registryReleaseDigest'
           JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
           JOIN simforge.native_map_asset_blobs b
             ON b.id = m.blob_id AND b.verification_state = 'verified'
          WHERE mv.id = :map_version_id
          ORDER BY m.relative_path`,
        { map_version_id: lineage.map_revision_id },
      );
      const expectedCount = Number(nativeMembers[0]?.object_count ?? -1);
      if (expectedCount < 1 || nativeMembers.length !== expectedCount) {
        throw new Error("native_map_asset_set_incomplete");
      }
      const renderMembers = nativeMembers.filter((member) => member.relative_path !== ".map-release.json");
      if (!renderMembers.some((member) => member.relative_path === "master.gltf")) {
        throw new Error("native_map_master_unavailable");
      }
      // Derivatives a backfill bound to this map version (geometry LODs, the
      // GPU texture tier) ride with the closure as ordinary map members.
      const derivatives = await boundDerivativeMembers(tx, lineage.map_revision_id, new Set(renderMembers.map((member) => member.relative_path)));
      renderMembers.push(...derivatives.members);
      // Refuse at submission, with advice, when warm workers have measured
      // this map at this tier and no native worker's GPU can hold it; the
      // alternative was a lease, minutes of scene loading and a timeout.
      // A full-resolution render of a map with the texture density derivative
      // uploads only the mip levels its cameras sample (per-job texture
      // residency), so the measured full-chain bytes overstate its demand:
      // the worker admits it on the job's own bytes and fails in seconds when
      // they do not fit (docs/engineering/texture-residency.md).
      const renderTextures = nativeRenderTextureTier(input.renderProfile, renderSpec.sources);
      const perJobResidency = renderTextures === "uastc-full"
        && renderMembers.some((member) => member.relative_path === NATIVE_TEXTURE_DENSITY_MANIFEST);
      const sceneBytes = perJobResidency ? null : await knownNativeSceneDemand(lineage.map_revision_id, renderTextures, tx);
      if (sceneBytes !== null) {
        const needed = sceneBytes + resources.estimatedGpuBytes;
        if (fleet.length > 0 && fleet.every((bytes) => needed > bytes - NATIVE_GPU_HEADROOM_BYTES)) {
          throw new NativeSceneMemoryError(needed, Math.max(...fleet), renderTextures);
        }
      }
      assertNativeMapMemberCapacity(renderMembers.length);
      const memberAssets = renderMembers.map((member) => nativeMapMemberAsset(member.relative_path, member.sha256, member.byte_length));
      if (new Set(memberAssets.map((asset) => asset.assetId)).size !== memberAssets.length) {
        throw new Error("native_map_input_id_conflict");
      }
      nativeClosure = {
        nativeMapAssetSetId: nativeMembers[0]!.asset_set_id!,
        derivativeSetIds: derivatives.setIds,
        members: memberAssets,
      };
      nativeAssets = [...memberAssets];
      const actorClosure = nativeActorAssetsInput();
      nativeAssets.push({
        assetId: NATIVE_ACTOR_ASSETS_INPUT_ID,
        kind: "catalog",
        sha256: actorClosure.sha256,
        sizeBytes: actorClosure.sizeBytes,
      });
    }
    // The render timeline every renderer samples, bound into the intent as the
    // `render.timeline` input (its bytes are the stored canonical JSON).
    // The explicit legacy replay (`original-xosc`) renders the revision's
    // OpenSCENARIO motion and binds no timeline; every other render binds one.
    const legacyReplay = motionSource === "original-xosc" || input.motionSource === "original-xosc";
    if (legacyReplay && simulation) throw new Error("render_motion_source_conflict");
    if (motionSource !== null && !legacyReplay && !(simulation?.timelineSha256 && simulation.timelineSizeBytes)) {
      throw new Error("render_timeline_missing");
    }
    const timelineAssets: NativeAsset[] = !legacyReplay && simulation?.timelineSha256 && simulation.timelineSizeBytes
      ? [{ assetId: RENDER_TIMELINE_INPUT_ID, kind: "other" as const, sha256: simulation.timelineSha256, sizeBytes: simulation.timelineSizeBytes }]
      : [];
    // The native engine renders from the timeline, or from the explicitly
    // requested legacy replay, and nothing else
    // (docs/engineering/no-silent-fallbacks.md): a revision whose simulation
    // has no timeline is refused here (the same code the engine would fail
    // with) instead of a worker leasing it first.
    if (input.engine === "native" && !legacyReplay && timelineAssets.length === 0) {
      throw new Error("native_render_timeline_missing");
    }
    const intent = buildIntent(input, lineage, [...nativeAssets, ...timelineAssets], fleetGpuBytes);
    const intentSha256 = hashRenderIntent(intent);
    // The row keeps the intent without its map members (they are the pinned
    // sets' registry rows); `intent_sha256` is still the full intent's hash.
    const stored = storedRenderIntent(intent, nativeClosure && {
      ...nativeClosure,
      offset: intent.assets.findIndex((asset) => asset.assetId === nativeClosure!.members[0]?.assetId),
    });
    const controlSha256 = canonicalJsonSha256({
      schema: "uniscenario.render-control-lineage/v1",
      intentSha256,
      executionPackageId: lineage.execution_package_id,
      sourceInputDigest: lineage.source_input_digest,
    });
    const rows = await tx.queryRows<InsertedJob>(
      `INSERT INTO simforge.render_jobs (
         id, workspace_id, revision_id, execution_package_id, execution_package_control_sha256,
         render_spec, render_spec_sha256, render_intent, intent_sha256, renderer_engine,
         parity_thresholds, resource_request, request_contract_version,
         job_mode, billing_mode, estimated_cost_cents, priority, idempotency_key, requested_by_user_id,
         sim_key, trace_sha256, timeline_sha256, motion_source, timeline_contact_origin
       ) VALUES (
         :id, :workspace_id, :revision_id, :execution_package_id, :control_sha256,
         CAST(:render_spec AS jsonb), :render_spec_sha256, CAST(:render_intent AS jsonb), :intent_sha256, :renderer_engine,
         CAST(:parity_thresholds AS jsonb), CAST(:resource_request AS jsonb), :request_contract_version,
         :job_mode, 'free', 0, :priority, :idempotency_key, :user_id,
         :sim_key, :trace_sha256, :timeline_sha256, :motion_source, :timeline_contact_origin
       )
       RETURNING id, revision_id, execution_package_id, job_mode, job_state, progress,
                 sim_key, trace_sha256, timeline_sha256, motion_source, timeline_contact_origin,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      {
        id: scenarioId("usrj"),
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
        control_sha256: controlSha256,
        render_spec: renderSpec,
        render_spec_sha256: canonicalJsonSha256(renderSpec),
        render_intent: stored,
        intent_sha256: intentSha256,
        renderer_engine: input.engine,
        parity_thresholds: input.engine === "carla"
          ? { positionM: 0.5, headingDeg: 2, speedMps: 0.5 }
          : null,
        resource_request: resources,
        request_contract_version: RENDER_INTENT_V1_SCHEMA,
        job_mode: input.engine === "browser" ? "browser_render" : "full_render",
        priority: input.priority ?? 0,
        idempotency_key: input.idempotencyKey,
        user_id: context.userId,
        sim_key: simulation?.simKey ?? null,
        trace_sha256: simulation?.traceSha256 ?? null,
        timeline_sha256: simulation?.timelineSha256 ?? null,
        motion_source: motionSource,
        timeline_contact_origin: simulation?.timelineContactOrigin ?? null,
      },
    );
    return rows[0] ?? null;
  });
  if (!inserted) return null;
  return {
    id: inserted.id,
    revisionId: inserted.revision_id,
    executionPackageId: inserted.execution_package_id,
    originRecordingJobId: null,
    mode: inserted.job_mode,
    status: inserted.job_state,
    progress: Number(inserted.progress),
    billingMode: "free",
    estimatedCost: 0,
    renderSpec,
    telemetry: {},
    parityResult: null,
    parityEvidence: null,
    resourceRequest: resources,
    workerAttestation: null,
    failureCode: null,
    failureDetail: null,
    simulation: inserted.sim_key && inserted.trace_sha256
      ? {
          simKey: inserted.sim_key,
          traceSha256: inserted.trace_sha256,
          timelineSha256: inserted.timeline_sha256 ?? null,
          engineSemVer: simulation?.simKey === inserted.sim_key ? simulation.engineSemVer ?? null : null,
        }
      : null,
    motionSource: inserted.motion_source ?? null,
    ...(inserted.timeline_contact_origin ? { timelineContactOrigin: inserted.timeline_contact_origin as ScenarioTimelineContactOrigin } : {}),
    createdAt: inserted.created_at,
    updatedAt: inserted.updated_at,
  };
}
