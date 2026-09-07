/**
 * The `hifi_preview` job family: leases queued `simforge.hifi_preview_requests`
 * and renders exactly ONE frame per request through `native-render-service`
 * (renderer/service — Bevy) on the registered, byte-verified native closure
 * of the request's immutable map version:
 *
 *   lease -> materialize the authorized semantic profile -> verify registered
 *   members and actor assets -> start the shared native service session ->
 *   load_scene_state / render -> store the exported PNG with provenance.
 *
 * Transport is the service's framed wire: one u32-LE length-prefixed msgpack
 * document per message, requests `{i, op, ...}`, responses echo `i`
 * (renderer/service/src/proto.rs). The request's contract camera report is
 * echoed verbatim into provenance so the camera pose round-trips exactly.
 *
 * Runs in two homes with the same executor:
 *   - `kickHifiPreviewExecutor()` — in-process drain inside the studio server
 *     (local PGlite is single-owner, so dev renders happen in-process);
 *   - `runHifiPreviewLoop()` — standalone polling worker
 *     (scripts/hifi-preview-worker.ts) for Postgres deployments.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  PINNED_ACTOR_ASSETS_SIZE_BYTES,
  NativeServiceTimeoutError,
  actorAssetsClosureUrl,
  assertActorAppearanceGrounded,
  ensureActorAssets,
  resolveActorAssets,
  resolveNativeRenderService,
  startNativeRenderService,
  type NativeActorAppearance,
  type NativeServiceSession,
} from "@simforge-oss/render/native";

import { LOCAL_ARTIFACT_BUCKET } from "../app/lib/db/config";
import { writeLocalObject } from "../app/lib/s3/s3-object";
import { ensureLocalMap } from "../app/lib/cloud/maps";
import { getRegisteredNativeMapSource } from "../app/lib/map-ingest/native-map-source";
import {
  HIFI_PREVIEW_PROVENANCE_SCHEMA,
  RENDERER_CONTRACT_VERSION,
  type CreateHifiPreviewInput,
  type HifiPreviewProvenance,
} from "@simforge-oss/studio-ui/lib/hifi-preview/contracts";
import {
  completeHifiPreview,
  failHifiPreview,
  leaseNextHifiPreview,
  type LeasedHifiPreview,
} from "../app/lib/hifi-preview/store";
import {
  HifiPreviewFailure,
  resolveNativeReadyMap,
  type NativeReadyMap,
} from "./native-ready-map";
import { computePayloadWorldBounds, framePayload } from "./payload-framing";
import { renderWithCoverageFallback, type RenderCamera } from "./preview-coverage";

const CONNECT_TIMEOUT_MS = 240_000; // covers prewarm + first shader compile
const RPC_TIMEOUT_MS = 120_000;
const PNG_EXPORT_TIMEOUT_MS = 60_000;
const SENSOR_ID = "hifi";

function cameraCoverage(response: Record<string, unknown>): number {
  const records = response.coverage;
  if (!Array.isArray(records)) return Number.NaN;
  const record = records.find((candidate) =>
    candidate !== null
    && typeof candidate === "object"
    && "sensorId" in candidate
    && candidate.sensorId === SENSOR_ID);
  return record && typeof record === "object" && "fraction" in record
    ? Number(record.fraction)
    : Number.NaN;
}

/**
 * V5 identity of the single GPU submission the response payloads were copied
 * from. A response without it is a protocol violation, not a default.
 */
function frameIdentity(response: Record<string, unknown>): HifiPreviewProvenance["submission"] {
  const frame = response.frame;
  if (
    frame === null || typeof frame !== "object"
    || !("simTick" in frame) || typeof frame.simTick !== "number"
    || !("sceneRevision" in frame) || typeof frame.sceneRevision !== "number"
    || !("rigRevision" in frame) || typeof frame.rigRevision !== "number"
    || !("generation" in frame) || typeof frame.generation !== "number"
  ) {
    throw new HifiPreviewFailure("renderer_frame_identity_missing", "render response carries no V5 frame identity");
  }
  return { simTick: frame.simTick, sceneRevision: frame.sceneRevision, rigRevision: frame.rigRevision, generation: frame.generation };
}


function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ component: "simforge-hifi-preview-worker", event, ...fields })}\n`);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    settle();
  }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}



/* ------------------------------------------------------- map payloads */


/** Resolve the exact registry release pinned by the requested map version. */
async function resolveMapPayloads(
  workspaceId: string,
  mapVersionId: string,
  requestedMapId: string,
  signal: AbortSignal,
): Promise<NativeReadyMap> {
  const { directory } = await ensureLocalMap(mapVersionId, "semantic", signal);
  const source = await getRegisteredNativeMapSource(workspaceId, mapVersionId);
  if (!source) {
    throw new HifiPreviewFailure(
      "map_payload_unavailable",
      `map version ${mapVersionId} has no registry-backed native source`,
    );
  }
  if (source.sourceMapAssetId !== null && requestedMapId !== source.sourceMapAssetId) {
    throw new HifiPreviewFailure(
      "map_payload_identity_mismatch",
      `requested map ${requestedMapId} does not match immutable map version ${mapVersionId}`,
      {
        requestedMapId,
        sourceMapAssetId: source.sourceMapAssetId,
        registryReleaseDigest: source.registryReleaseDigest,
      },
    );
  }
  return resolveNativeReadyMap({
    directory,
    mapId: requestedMapId,
    releaseDigest: source.registryReleaseDigest,
    members: source.members,
  });
}

/* ------------------------------------------------------------ executor */

export async function executeHifiPreview(
  lease: LeasedHifiPreview,
  signal: AbortSignal,
): Promise<{ artifactBucket: string; artifactKey: string; provenance: HifiPreviewProvenance }> {
  const t0 = Date.now();
  const request: CreateHifiPreviewInput = lease.request;
  const binary = resolveNativeRenderService();
  if (binary.state === "missing") {
    throw new HifiPreviewFailure(
      "renderer_unavailable",
      `native-render-service is not installed (looked in ${binary.searched.join(", ")})`,
    );
  }

  const nativeMap = await resolveMapPayloads(lease.workspaceId, request.mapVersionId, request.scene.mapId, signal);
  const worldBounds = await computePayloadWorldBounds([nativeMap.masterPath]);
  const framedCamera = framePayload(
    worldBounds,
    request.width / request.height,
    request.camera.intrinsics.fovYDeg,
  );

  const workspace = await mkdtemp(join(tmpdir(), "simforge-hifi-"));
  const exportRoot = join(workspace, "export");
  const sceneSpecPath = join(workspace, "scene.json");
  let session: NativeServiceSession | undefined;
  try {
    const appearances: NativeActorAppearance[] = [];
    for (const actor of request.scene.actors) {
      if (actor.kind !== "despawn") {
        appearances.push({ actorId: actor.id, catalogId: actor.catalogId, authored: true });
      }
    }
    let actorDirectory: string | undefined;
    if (appearances.length > 0) {
      const actorSource = resolveActorAssets();
      if (actorSource.state === "missing") {
        throw new HifiPreviewFailure(
          "actor_assets_unavailable",
          `the pinned actor closure ${actorSource.digest} is not installed`,
          { searched: actorSource.searched },
        );
      }
      const closurePath = actorSource.closurePath ?? join(workspace, "actor-closure.json");
      if (actorSource.closurePath === null) {
        const response = await fetch(actorAssetsClosureUrl(actorSource.digest, actorSource.blobBaseUrl), { signal });
        if (!response.ok) throw new Error(`actor closure download failed: ${response.status}`);
        await writeFile(closurePath, new Uint8Array(await response.arrayBuffer()));
      }
      const actorAssets = await ensureActorAssets({
        closure: { path: closurePath, sha256: actorSource.digest, sizeBytes: PINNED_ACTOR_ASSETS_SIZE_BYTES },
        destination: join(workspace, "actor-assets"),
        baseUrl: actorSource.blobBaseUrl,
        cacheDir: actorSource.source.kind === "directory"
          ? actorSource.source.root
          : process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR ?? join(tmpdir(), "simforge-actor-assets"),
      });
      assertActorAppearanceGrounded(appearances, [], actorAssets);
      actorDirectory = actorAssets.directory;
    }
    await writeFile(sceneSpecPath, JSON.stringify({
      glbs: [nativeMap.masterPath],
      profile: request.profile,
      nearM: Math.min(Math.max(request.camera.intrinsics.near, 0.05), 10),
      farM: Math.min(Math.max(request.camera.intrinsics.far, 200), 4000),
      warmupFrames: 10,
      vehicleModels: actorDirectory,
      pedestrianModels: actorDirectory,
    }));
    session = await startNativeRenderService({
      binary: binary.path,
      workspace,
      jobId: lease.requestId,
      scenePath: sceneSpecPath,
      signal,
      startupTimeoutMs: CONNECT_TIMEOUT_MS,
      shmSizeMb: 128,
    });
    const { client } = session;
    const prewarmMs = Date.now() - t0;
    await client.rpc({ op: "load_scene_state", states: [request.scene] }, RPC_TIMEOUT_MS);

    const requestedCamera: RenderCamera = {
      eye: request.camera.pose.position,
      target: request.camera.pose.target,
    };
    const rendered = await renderWithCoverageFallback({
      requestedCamera,
      framedCamera,
      worldBounds,
      render: async (camera, attempt) => {
        const attemptExportDir = join(exportRoot, attempt);
        const fields = {
          tick_id: request.tick,
          cameras: [{
            sensorId: SENSOR_ID,
            width: request.width,
            height: request.height,
            fovDeg: request.camera.intrinsics.fovYDeg,
            eye: camera.eye,
            target: camera.target,
          }],
          tick_index: 0,
        };
        const response = await client.rpc({
          op: "render",
          ...fields,
          export_dir: attemptExportDir,
        }, RPC_TIMEOUT_MS);
        return {
          response,
          exportDir: attemptExportDir,
          coverage: cameraCoverage(response),
          renderMs: Number(response.server_ms ?? 0),
        };
      },
    });
    const renderMs = rendered.renderMs;

    // PNG export is demoted off the render critical path (WSB5); wait for it.
    const pngPath = join(rendered.exportDir, `tick-${String(request.tick).padStart(6, "0")}.${SENSOR_ID}.rgb.png`);
    const pngDeadline = Date.now() + PNG_EXPORT_TIMEOUT_MS;
    let pngBytes: Buffer | null = null;
    while (Date.now() < pngDeadline) {
      if (signal.aborted) throw new HifiPreviewFailure("aborted", "worker shutdown during export");
      try {
        const info = await stat(pngPath);
        if (info.size > 0) {
          // Two reads a tick apart guard against catching a partial write.
          const first = await readFile(pngPath);
          await delay(50);
          const second = await readFile(pngPath);
          if (first.length === second.length) {
            pngBytes = second;
            break;
          }
        }
      } catch {
        // not exported yet
      }
      await delay(100);
    }
    if (!pngBytes) {
      throw new HifiPreviewFailure("render_export_timeout", `PNG export never appeared at ${pngPath}`, {
        stderr: await session.readStderr(),
      });
    }

    await session.close();

    const frameSha256 = createHash("sha256").update(pngBytes).digest("hex");
    const artifactKey = `hifi-preview/${lease.requestId}/frame.png`;
    await writeLocalObject(LOCAL_ARTIFACT_BUCKET, artifactKey, pngBytes, "image/png");

    const provenance: HifiPreviewProvenance = {
      schema: HIFI_PREVIEW_PROVENANCE_SCHEMA,
      renderer: "bevy-native",
      rendererProtocol: session.protocol,
      contractVersion: RENDERER_CONTRACT_VERSION,
      profile: request.profile,
      tick: request.tick,
      mapVersionId: request.mapVersionId,
      mapId: request.scene.mapId,
      mapDigest: nativeMap.mapDigest,
      payloadDigests: nativeMap.payloads.map((payload) => payload.sha256),
      // The request report remains intact; renderedCamera records framing.
      camera: request.camera,
      renderedCamera: { position: rendered.camera.eye, target: rendered.camera.target },
      coverage: rendered.coverage,
      fallbackFraming: rendered.fallbackFraming,
      worldBounds,
      frame: {
        width: request.width,
        height: request.height,
        pass: "rgb",
        sha256: frameSha256,
        sizeBytes: pngBytes.byteLength,
      },
      submission: frameIdentity(rendered.response),
      map: {
        tileCount: 1,
        payloads: nativeMap.payloads.map((payload) => ({
          path: payload.relativePath,
          sha256: payload.sha256,
          sizeBytes: payload.sizeBytes,
        })),
      },
      timings: { prewarmMs, renderMs, totalMs: Date.now() - t0 },
      renderedAt: new Date().toISOString(),
    };
    return { artifactBucket: LOCAL_ARTIFACT_BUCKET, artifactKey, provenance };
  } catch (error) {
    if (error instanceof HifiPreviewFailure) throw error;
    throw new HifiPreviewFailure(
      signal.aborted ? "aborted" : error instanceof NativeServiceTimeoutError ? "renderer_rpc_timeout" : "renderer_error",
      error instanceof Error ? error.message : String(error),
      { stderr: await session?.readStderr() ?? "" },
    );
  } finally {
    await session?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------- schedulers */

async function runOne(lease: LeasedHifiPreview, signal: AbortSignal): Promise<void> {
  log("request.started", { requestId: lease.requestId, mapVersionId: lease.request.mapVersionId, profile: lease.request.profile });
  try {
    const result = await executeHifiPreview(lease, signal);
    await completeHifiPreview(lease, result);
    log("request.succeeded", {
      requestId: lease.requestId,
      artifactKey: result.artifactKey,
      totalMs: result.provenance.timings.totalMs,
    });
  } catch (error) {
    const failure = error instanceof HifiPreviewFailure
      ? error
      : new HifiPreviewFailure("execution_error", error instanceof Error ? error.message : String(error));
    await failHifiPreview(lease, {
      errorCode: failure.code,
      errorDetail: { message: failure.message, ...failure.detail },
    }).catch((storeError) => log("request.fail_write_error", { requestId: lease.requestId, error: String(storeError) }));
    log("request.failed", { requestId: lease.requestId, code: failure.code, message: failure.message });
  }
}

async function drainQueue(workerId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const lease = await leaseNextHifiPreview({ workerId });
    if (!lease) return;
    await runOne(lease, signal);
  }
}

type ExecutorHandle = { pending: boolean; running: boolean };
const executorKey = Symbol.for("simforge.hifi-preview.executor");

/**
 * In-process executor for the studio server: local PGlite is single-owner,
 * so the API route that enqueues a request also kicks this drain. Reentrant
 * kicks while a drain is running only mark it pending — one drain at a time.
 */
export function kickHifiPreviewExecutor(): void {
  const globals = globalThis as typeof globalThis & { [executorKey]?: ExecutorHandle };
  const handle = globals[executorKey];
  if (handle?.running) {
    handle.pending = true;
    return;
  }
  const next: ExecutorHandle = { pending: false, running: true };
  globals[executorKey] = next;
  const workerId = `studio-inline:${hostname()}:${process.pid}`;
  void (async () => {
    try {
      do {
        next.pending = false;
        await drainQueue(workerId, new AbortController().signal);
      } while (next.pending);
    } catch (error) {
      log("executor.error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      next.running = false;
    }
  })();
}

export type HifiPreviewWorkerOptions = {
  signal: AbortSignal;
  workerId?: string;
  idleDelayMs?: number;
};

/** Standalone polling loop (scripts/hifi-preview-worker.ts). */
export async function runHifiPreviewLoop(options: HifiPreviewWorkerOptions): Promise<void> {
  const workerId = options.workerId ?? `hifi-preview:${hostname()}:${process.pid}`;
  const idleDelayMs = options.idleDelayMs ?? 1_500;
  log("worker.started", { workerId, binary: resolveNativeRenderService() });
  while (!options.signal.aborted) {
    const lease = await leaseNextHifiPreview({ workerId });
    if (!lease) {
      try {
        await delay(idleDelayMs, options.signal);
      } catch {
        break;
      }
      continue;
    }
    await runOne(lease, options.signal);
  }
  log("worker.stopped", { workerId });
}
