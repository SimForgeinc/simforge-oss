import "server-only";
import type {
  LocalRenderCapability,
  LocalRenderDependency,
  RenderWorkerCapability,
  ScenarioRendererEngine,
} from "@simforge-oss/studio-host";
import { probeLocalNativeRender, type LocalExecutable } from "@simforge-oss/render/native";
import { liveLocalWorkers } from "@/app/lib/scenario/jobs/local-native-render-store";

/**
 * What this machine can render right now, from the same probe the worker
 * uses to decide which engines it claims, plus whether that worker is
 * actually attached. Nothing here is inferred from the installed shell or a
 * manifest alone: executables are checked on disk and worker presence is the
 * worker's own recent poll.
 */

function dependency(executable: LocalExecutable): LocalRenderDependency {
  return executable.state === "available"
    ? { state: "available", path: executable.path, source: executable.source }
    : { state: "missing", path: null, source: null };
}

export function localRenderCapability(): LocalRenderCapability {
  const probe = probeLocalNativeRender();
  const workers = liveLocalWorkers();
  const nativeWorker = workers.find((worker) => worker.engines.includes("native")) ?? workers[0] ?? null;
  const reasons = [...probe.reasons];
  if (!nativeWorker) reasons.push("The local render worker is not attached to this host.");
  else if (!nativeWorker.engines.includes("native")) reasons.push("The attached local worker does not offer the native engine.");
  const actorAssets = probe.actorAssets.state === "available"
    ? {
        state: "available" as const,
        path: probe.actorAssets.closurePath ?? probe.actorAssets.blobBaseUrl,
        source: probe.actorAssets.source.kind === "directory" ? probe.actorAssets.source.source : ("env" as const),
        digest: probe.actorAssets.digest,
      }
    : { state: "missing" as const, path: null, source: null, digest: probe.actorAssets.digest };
  return {
    engine: "native",
    ready: reasons.length === 0,
    runtimeRoot: probe.runtimeRoot,
    renderService: dependency(probe.renderService),
    encoder: dependency(probe.encoder),
    actorAssets,
    worker: {
      attached: nativeWorker !== null,
      workerId: nativeWorker?.workerId ?? null,
      lastSeenAt: nativeWorker?.lastSeenAt ?? null,
      engines: (nativeWorker?.engines ?? []).filter((engine): engine is ScenarioRendererEngine => engine === "browser" || engine === "native"),
    },
    reasons,
  };
}

/**
 * The engines this host offers for submission and whether each has capacity
 * now. `native` is this machine's Bevy lane; `browser` is the Three.js
 * capture lane, offered only when the attached worker proved it can run it.
 * CARLA and cloud rendering are not offered by a local host: absent keys,
 * never "ready".
 */
export function localRenderWorkers(local: LocalRenderCapability): Partial<Record<ScenarioRendererEngine, RenderWorkerCapability>> {
  const workers = liveLocalWorkers();
  const browserWorker = workers.find((worker) => worker.engines.includes("browser"));
  return {
    native: local.ready
      ? { available: true, reason: null }
      : { available: false, reason: local.reasons.join(" ") },
    browser: browserWorker
      ? { available: true, reason: null }
      : {
          available: false,
          reason: workers.length === 0
            ? "The local render worker is not attached to this host."
            : "The attached local worker cannot run the browser capture engine on this machine (Chromium, ffmpeg or ffprobe missing).",
        },
  };
}
