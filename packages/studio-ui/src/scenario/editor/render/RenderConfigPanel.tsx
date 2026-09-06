"use client";

import { useStudioHost } from "../../../host";
import { useStudioHostCapabilities } from "@simforge-oss/studio-host/react";
import type { ScenarioRendererEngine, StudioHostCapabilities } from "@simforge-oss/studio-host";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Camera,
  Clock,
  FlaskConical,
  MonitorPlay,
  Server,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import {
  EnvironmentSchema,
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  templateRenderDefaults,
  type ActorSensor,
  type Environment,
  type RenderModality,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";
import { cn } from "../../../lib/utils";
import { loadCarlaCompatibility } from "../../../lib/scenario/carla-compatibility";
import {
  carlaRenderWarnings,
  type CarlaRenderWarning,
} from "../../../lib/scenario/carla-render-warnings";
import {
  RenderOptionCard,
  RenderWizardBody,
  RenderWizardFooter,
  RenderWizardStepRail,
  type RenderWizardStep,
} from "./RenderWizardChrome";
import { RenderSettingsFields } from "./RenderSettingsFields";
import { formatElapsed } from "./render-view-model";
import {
  authoredRenderSensors,
  buildCanonicalRenderSpec,
  defaultModalities,
  renderModalityLabel,
  sensorKey,
  supportedModalities,
  type AuthoredRenderSensor,
} from "./render-spec-v3";
type RenderBackend = ScenarioRendererEngine | "esmini";

const ESMINI_VALIDATOR_VERSION = "3.6.0";

type VideoResolution = { width: number; height: number; label: string };
const RENDERER_RESOLUTIONS: readonly VideoResolution[] = [{ width: 1280, height: 720, label: "720p" }];
const RENDERER_FPS_OPTIONS: readonly number[] = [24];
const CARLA_QUALITIES = ["preview", "standard", "high", "cinematic"] as const;
const EXPORT_POLL_MS = 1_000;
/**
 * How long an export may sit queued with no attempt before the wait is called off.
 *
 * A `running` export is progressing and gets as long as it needs. One nothing has claimed is a
 * different situation, and the previous unbounded loop made a deployment with no compiler worker
 * indistinguishable from a slow one — it waited for the life of the tab behind one static label.
 */
const EXPORT_CLAIM_TIMEOUT_MS = 120_000;

/**
 * Where SimForge executes the immutable render intent, in preference order: native is the
 * default; the wizard falls through this list when a host does not offer it. Each renderer is a
 * registered GPU worker. The tab only submits and observes the durable job; closing it cannot
 * interrupt execution.
 */
const ENGINE_OPTIONS: {
  id: RenderBackend;
  label: string;
  icon: typeof MonitorPlay;
  hint: string;
}[] = [
  {
    id: "native",
    label: "Native",
    icon: Server,
    hint: "Bevy retained native renderer on a registered GPU worker.",
  },
  {
    id: "carla",
    label: "CARLA",
    icon: Server,
    hint: "CARLA-native render on a registered GPU worker.",
  },
  {
    id: "browser",
    label: "Browser",
    icon: MonitorPlay,
    hint: "Optimized Three.js renderer on a registered GPU worker.",
  },
  {
    id: "esmini",
    label: "esmini",
    icon: FlaskConical,
    hint: "Headless cross-engine replay. State trace and validation report, no imagery.",
  },
];

/**
 * The host's truthful answer for one engine card. esmini runs on the CPU job lane and is not a
 * registered renderer. Every other engine is either not offered by this host at all (no
 * capability key: submission would be rejected), offered without healthy capacity right now, or
 * ready. A host that runs the native renderer from a binary on this machine additionally reports
 * whether that runtime is installed; a host whose native lane is managed capacity does not.
 */
function engineAvailability(
  engine: RenderBackend,
  capabilities: StudioHostCapabilities | null,
): { offered: boolean; badge: string | null; reason: string | null } {
  if (engine === "esmini") return { offered: true, badge: null, reason: null };
  if (!capabilities) return { offered: false, badge: "Checking host", reason: null };
  const worker = capabilities.execution.renderWorkers[engine];
  if (!worker) {
    return { offered: false, badge: "Not offered", reason: `${capabilities.host.label} does not accept ${engine} renders.` };
  }
  const nativeRuntime = capabilities.execution.nativeRuntime;
  if (engine === "native" && nativeRuntime.state === "unavailable" && nativeRuntime.code !== "not_offered") {
    return { offered: true, badge: "Runtime not installed", reason: nativeRuntime.reason };
  }
  return worker.available
    ? { offered: true, badge: "Worker ready", reason: null }
    : { offered: true, badge: "No worker", reason: worker.reason };
}


const SENSOR_KINDS: {
  id: RenderModality;
  label: string;
  hint: string;
}[] = [
  { id: "rgb", label: "RGB", hint: "Color video stream" },
  { id: "depth", label: "Depth", hint: "Metric depth video stream" },
  { id: "semantic", label: "Semantic", hint: "Semantic segmentation" },
  { id: "instance", label: "Instance", hint: "Instance segmentation" },
  { id: "lidar", label: "LiDAR", hint: "Point-cloud captures" },
  { id: "radar", label: "Radar", hint: "Range, angle and radial-velocity captures" },
];

const OUTPUT_OPTIONS: { id: "video" | "sensorArchive" | "annotations"; label: string; hint: string }[] = [
  { id: "video", label: "Videos", hint: "One encoded video per camera, plus lidar/radar visualizations" },
  { id: "sensorArchive", label: "Sensor data archives", hint: "Lidar point clouds and radar CSV per sensor" },
  { id: "annotations", label: "Annotations", hint: "Frame-aligned NDJSON" },
];

const ENGINE_STEP: RenderWizardStep = { id: "engine", label: "Engine" };
const CAMERA_STEP: RenderWizardStep = { id: "cameras", label: "Cameras" };
const OUTPUT_STEP: RenderWizardStep = { id: "output", label: "Output" };
const SETTINGS_STEP: RenderWizardStep = { id: "settings", label: "Settings" };
const REVIEW_STEP: RenderWizardStep = { id: "review", label: "Review" };

/**
 * The steps each engine actually has decisions for.
 *
 * esmini has none: it replays the frozen export at a pinned timestep with no cameras and no
 * format, so offering it a sensor step would be offering a choice that changes nothing.
 */
const STEPS_BY_ENGINE: Record<RenderBackend, readonly RenderWizardStep[]> = {
  browser: [ENGINE_STEP, CAMERA_STEP, OUTPUT_STEP, SETTINGS_STEP, REVIEW_STEP],
  carla: [ENGINE_STEP, CAMERA_STEP, OUTPUT_STEP, SETTINGS_STEP, REVIEW_STEP],
  native: [ENGINE_STEP, CAMERA_STEP, OUTPUT_STEP, SETTINGS_STEP, REVIEW_STEP],
  esmini: [ENGINE_STEP, REVIEW_STEP],
};

const managedSensorOptions = authoredRenderSensors;

function sensorOptionKey(option: AuthoredRenderSensor) {
  return sensorKey(option.actorId, option.sensor.id);
}

function sensorLabel(sensor: ActorSensor) {
  if (sensor.label?.trim()) return sensor.label;
  if (sensor.type === "dash_camera") return "Dash camera";
  if (sensor.type === "lidar") return "LiDAR";
  return "Radar";
}

function sensorDetail(option: AuthoredRenderSensor) {
  const fov = option.sensor.type === "dash_camera"
    ? option.sensor.camera.horizontalFovDeg
    : option.sensor.field.horizontalFovDeg;
  return `${option.actorLabel} · ${option.sensor.type.replace("_", " ")} · ${Math.round(fov)}° FOV`;
}

/** The chase camera is a presentation view; it does not count toward the physical rig. */
function physicalSensorCount(sensors: readonly AuthoredRenderSensor[]): number {
  return sensors.filter((option) => option.sensor.id !== PRONTO_CHASE_CAMERA_SENSOR_ID).length;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function StepHeading({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex shrink-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
        {hint ? <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p> : null}
      </div>
      {aside ? (
        <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">{aside}</span>
      ) : null}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b render-hairline py-1.5 last:border-b-0">
      <dt className="text-micro uppercase tracking-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-xs font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The "New render" view authors one canonical render-spec/v3 across browser and managed targets.
 *
 * It is a short wizard rather than one form. Every control used to be on screen at once — engine,
 * sensors, kinds, clip, outputs, resolution, FPS, quality, preflight, submit — inside a scrolling
 * column, which made the cheapest possible render (this browser, the cameras already mounted)
 * indistinguishable in effort from the most expensive one. The steps are Engine, Cameras, Output,
 * Review; esmini skips the two it has no decisions for.
 *
 * Physical sensors, modalities, clip and artifacts remain explicit author controls. Both renderer
 * engines receive the byte-identical render-spec/v3 inside one immutable render intent. The
 * renderer choice is an admission constraint, not a backend-specific lowering.
 */
export function RenderConfigPanel({
  ensureSnapshot,
  currentContent,
  onClose,
  onManagedJobCreated,
  onEsminiRunCreated,
}: {
  /**
   * Freezes the open draft into an immutable snapshot and resolves its id. Called once a submit
   * begins, never on open: configuring a render must not write.
   */
  ensureSnapshot: (signal?: AbortSignal) => Promise<string>;
  currentContent: ScenarioTemplateV2 | null;
  onClose: () => void;
  onManagedJobCreated: (jobId: string) => void;
  onEsminiRunCreated: () => void;
}) {
  const studioHost = useStudioHost();
  const [backend, setBackend] = useState<RenderBackend>("native");
  const hostCapabilitiesState = useStudioHostCapabilities(studioHost);
  const hostCapabilities = hostCapabilitiesState.capabilities;
  const [stepIndex, setStepIndex] = useState(0);
  const sensorOptions = useMemo(
    () => managedSensorOptions(currentContent).filter(
      (option) => backend !== "native" || option.sensor.type === "dash_camera",
    ),
    [backend, currentContent],
  );
  const [selectedSensorKeys, setSelectedSensorKeys] = useState<string[]>([]);
  const [modalitiesBySensor, setModalitiesBySensor] = useState<Record<string, RenderModality[]>>({});
  const [kinds, setKinds] = useState<RenderModality[]>(["rgb", "lidar", "radar"]);
  /**
   * The video format the scenario authored as its capture default (`simforge.render-defaults`),
   * offered first and selected until the author picks another. A carrier that is not a valid
   * render spec is reported at submit, where `buildCanonicalRenderSpec` reads it again.
   */
  const authoredVideo = useMemo(() => {
    if (!currentContent) return null;
    try {
      return templateRenderDefaults(currentContent)?.video ?? null;
    } catch {
      return null;
    }
  }, [currentContent]);
  const resolutions = useMemo<readonly VideoResolution[]>(
    () => authoredVideo && !RENDERER_RESOLUTIONS.some((item) => item.width === authoredVideo.width && item.height === authoredVideo.height)
      ? [{ width: authoredVideo.width, height: authoredVideo.height, label: "Scenario default" }, ...RENDERER_RESOLUTIONS]
      : RENDERER_RESOLUTIONS,
    [authoredVideo],
  );
  const fpsOptions = useMemo<readonly number[]>(
    () => authoredVideo && !RENDERER_FPS_OPTIONS.includes(authoredVideo.fps)
      ? [authoredVideo.fps, ...RENDERER_FPS_OPTIONS]
      : RENDERER_FPS_OPTIONS,
    [authoredVideo],
  );
  const [resolutionIndex, setResolutionIndex] = useState(0);
  const [fps, setFps] = useState<number>(() => authoredVideo?.fps ?? 24);
  const [quality, setQuality] = useState<(typeof CARLA_QUALITIES)[number]>("standard");
  const [outputs, setOutputs] = useState<("video" | "sensorArchive" | "annotations")[]>(["video"]);
  const [durationSeconds, setDurationSeconds] = useState(
    () => currentContent?.choreography.clipSeconds ?? 20,
  );
  const [renderEnvironment, setRenderEnvironment] = useState<Environment>(
    () => currentContent?.environment ?? EnvironmentSchema.parse({}),
  );
  const [stage, setStage] = useState<null | "package" | "submit">(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * CARLA actor drop/substitution preflight. `error` is shown as such: a compatibility table that
   * could not be loaded must not read as "no known limitations".
   */
  const [carlaWarnings, setCarlaWarnings] = useState<
    { status: "idle" } | { status: "loading" } | { status: "ready"; warnings: CarlaRenderWarning[] } | { status: "error"; message: string }
  >({ status: "idle" });
  useEffect(() => {
    if (backend !== "carla") {
      setCarlaWarnings({ status: "idle" });
      return;
    }
    let active = true;
    setCarlaWarnings({ status: "loading" });
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaWarnings({ status: "ready", warnings: carlaRenderWarnings(currentContent, table) });
      })
      .catch((cause: unknown) => {
        if (active) {
          setCarlaWarnings({
            status: "error",
            message: cause instanceof Error ? cause.message : "Could not load CARLA compatibility.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [backend, currentContent]);
  /** What the export queue is doing while `stage === "package"`. Null when nothing is waiting. */
  const [packageWait, setPackageWait] = useState<
    null | { exportId: string; status: string; claimed: boolean; startedAtMs: number }
  >(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (stage === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const steps = STEPS_BY_ENGINE[backend];
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? ENGINE_STEP;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const clipSeconds = currentContent?.choreography.clipSeconds ?? 20;
  useEffect(() => {
    setDurationSeconds(clipSeconds);
    setRenderEnvironment(currentContent?.environment ?? EnvironmentSchema.parse({}));
    setResolutionIndex(0);
    setFps(authoredVideo?.fps ?? 24);
  }, [authoredVideo, clipSeconds, currentContent]);
  useEffect(() => {
    setSelectedSensorKeys((current) => {
      const available = new Set(sensorOptions.map(sensorOptionKey));
      const kept = current.filter((key) => available.has(key));
      return kept.length > 0 ? kept : [...available];
    });
  }, [sensorOptions]);

  useEffect(() => {
    setModalitiesBySensor((current) => Object.fromEntries(sensorOptions.map((option) => {
      const key = sensorOptionKey(option);
      const supported = new Set(
        backend === "native" ? ["rgb" as const] : supportedModalities(option.sensor),
      );
      const preserved = current[key]?.filter((modality) => supported.has(modality));
      return [key, preserved && preserved.length > 0 ? preserved : [...defaultModalities(option.sensor)].filter((modality) => supported.has(modality))];
    })));
  }, [backend, sensorOptions]);

  const selectedSensors = useMemo(() => {
    const selected = new Set(selectedSensorKeys);
    return sensorOptions.filter((option) => selected.has(sensorOptionKey(option)));
  }, [selectedSensorKeys, sensorOptions]);
  const resolution = resolutions[resolutionIndex] ?? resolutions[0]!;
  const selectedModalities = useMemo(
    () => selectedSensors.map((option) => ({
      actorId: option.actorId,
      sensorId: option.sensor.id,
      modalities: (modalitiesBySensor[sensorOptionKey(option)] ?? []).filter(
        (modality) => (backend === "native" ? modality === "rgb" : supportedModalities(option.sensor).includes(modality)),
      ),
    })).filter((selection) => selection.modalities.length > 0),
    [backend, modalitiesBySensor, selectedSensors],
  );
  const sensorHostAssets = useMemo(() => {
    if (!currentContent) return [];
    const selectedActors = new Set(selectedSensors.map((option) => option.actorId));
    return [...new Set(
      currentContent.roles
        .filter((role) => selectedActors.has(role.id))
        .map((role) => role.actor.catalogId),
    )];
  }, [currentContent, selectedSensors]);
  const selectedKinds = [...new Set(selectedModalities.flatMap((selection) => selection.modalities))];
  const sensorCount = selectedModalities.reduce((total, selection) => total + selection.modalities.length, 0);
  const physicalSensors = physicalSensorCount(selectedSensors);
  const engineAvailabilityState = engineAvailability(backend, hostCapabilities);

  const issues = useMemo(() => {
    const list: string[] = [];
    if (sensorOptions.length === 0) {
      list.push("Add a camera or sensor rig before rendering.");
    } else if (selectedSensors.length === 0) {
      list.push("Select at least one sensor.");
    } else if (selectedModalities.length !== selectedSensors.length) {
      list.push("Every selected sensor needs at least one modality.");
    }
    if (
      outputs.includes("video")
      && !selectedModalities.some((selection) => selection.modalities.includes("rgb"))
    ) {
      list.push("Video output requires an RGB modality.");
    }
    if (outputs.length === 0) list.push("Enable at least one output.");
    return list;
  }, [outputs, selectedModalities, selectedSensors.length, sensorOptions.length]);

  /**
   * An engine the host has not confirmed it accepts never reaches submission: while capabilities
   * are still loading or failed to load, the wizard cannot tell an offered engine from one the
   * host would reject as an invalid render job. Missing capacity is different — a durable job may
   * queue until a worker appears — and is shown, not gated.
   */
  const hostBlock = backend === "esmini"
    ? null
    : hostCapabilitiesState.status === "loading"
      ? "Checking which render engines this host accepts…"
      : hostCapabilitiesState.status === "error"
        ? `Could not read this host's render capabilities: ${hostCapabilitiesState.error.message}`
        : engineAvailabilityState.offered
          ? null
          : engineAvailabilityState.reason;

  const submitDisabled = stage != null || issues.length > 0 || hostBlock !== null;

  // The wizard opens on native. A host that does not offer it moves the selection to the first
  // engine it does, so the author never starts on a card they cannot submit.
  useEffect(() => {
    if (hostCapabilitiesState.status !== "ready" || engineAvailability(backend, hostCapabilities).offered) return;
    const fallback = ENGINE_OPTIONS.find((option) => engineAvailability(option.id, hostCapabilities).offered);
    if (fallback) setBackend(fallback.id);
  }, [backend, hostCapabilities, hostCapabilitiesState.status]);

  function selectBackend(next: RenderBackend) {
    if (!engineAvailability(next, hostCapabilities).offered) return;
    setBackend(next);
    if (next === "native") setOutputs(["video"]);
    setSubmitError(null);
    setStepIndex(0);
  }

  function toggleSensor(key: string, enabled: boolean) {
    setSelectedSensorKeys((current) => {
      const next = new Set(current);
      if (enabled) next.add(key);
      else next.delete(key);
      return sensorOptions.map(sensorOptionKey).filter((candidate) => next.has(candidate));
    });
  }

  function toggleKind(kind: RenderModality) {
    const enabling = !kinds.includes(kind);
    setKinds((current) => enabling
      ? [...current, kind]
      : current.filter((candidate) => candidate !== kind));
    setModalitiesBySensor((current) => Object.fromEntries(sensorOptions.map((option) => {
      const key = sensorOptionKey(option);
      const supported = supportedModalities(option.sensor);
      const values = current[key] ?? [...defaultModalities(option.sensor)];
      if (!supported.includes(kind)) return [key, values];
      return [key, enabling
        ? [...new Set([...values, kind])]
        : values.filter((candidate) => candidate !== kind)];
    })));
  }

  function toggleSensorModality(key: string, modality: RenderModality) {
    setModalitiesBySensor((current) => {
      const values = current[key] ?? [];
      return {
        ...current,
        [key]: values.includes(modality)
          ? values.filter((candidate) => candidate !== modality)
          : [...values, modality],
      };
    });
  }

  function toggleOutput(id: "video" | "sensorArchive" | "annotations") {
    setOutputs((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  /**
   * Freeze the scenario, then make sure that snapshot has an execution package.
   *
   * The snapshot is taken here rather than when the pane opened: this is the first moment the
   * scenario has to be immutable, because it is what the worker executes and what the author can
   * later restore. `ensureSnapshot` is idempotent per draft version.
   */
  async function ensureExecutionPackage(): Promise<{
    revisionId: string;
    executionPackageId: string;
  }> {
    const revisionId = await ensureSnapshot();
    // Reconcile by immutable revision before creating anything — survives reloads and lost POSTs.
    const existing = await studioHost.jobs.listExports(revisionId);
    let record =
      existing.find((candidate) => candidate.status === "succeeded" && candidate.executionPackageId)
      ?? existing.find((candidate) => candidate.status === "queued" || candidate.status === "running")
      ?? null;
    record ??= await studioHost.jobs.prepareExport(
      revisionId,
      `render-tab-export:${revisionId}:${crypto.randomUUID()}`,
    );
    const waitStartedMs = Date.now();
    let unclaimedSinceMs: number | null = null;
    while (record.status === "queued" || record.status === "running") {
      // The author sees this while it happens. Waiting behind a static label is how a compiler
      // outage looks identical to a compiler working, which is the whole complaint.
      setPackageWait({
        exportId: record.id,
        status: record.status,
        claimed: record.startedAt !== null,
        startedAtMs: waitStartedMs,
      });
      // A `running` export is progressing and gets as long as it needs. One still queued with no
      // `startedAt` has not been claimed at all, and more waiting will not change that: on a
      // deployment with no compiler worker this loop otherwise spins for the life of the tab.
      const unclaimed = record.status === "queued" && record.startedAt === null;
      unclaimedSinceMs = unclaimed ? unclaimedSinceMs ?? Date.now() : null;
      if (unclaimedSinceMs !== null && Date.now() - unclaimedSinceMs > EXPORT_CLAIM_TIMEOUT_MS) {
        throw new Error(
          "No OpenSCENARIO compiler picked this export up — it is still queued, unclaimed. The "
          + "render cannot be submitted until a compiler worker is running.",
        );
      }
      await delay(EXPORT_POLL_MS);
      record = await studioHost.jobs.getExport(record.id);
    }
    if (record.status !== "succeeded" || !record.executionPackageId) {
      throw new Error(record.errorCode ?? "The OpenSCENARIO export did not produce an execution package.");
    }
    return { revisionId, executionPackageId: record.executionPackageId };
  }

  async function submitGpuRender() {
    if (stage != null || backend === "esmini" || hostBlock !== null) return;
    setSubmitError(null);
    setStage("package");
    try {
      if (!currentContent) throw new Error("The scenario is not ready to render.");
      const renderSpec = buildCanonicalRenderSpec({
        content: currentContent,
        selections: selectedModalities,
        clip: { startSeconds: 0, endSeconds: durationSeconds },
        video: outputs.includes("video") ? {
          width: resolution.width,
          height: resolution.height,
          fps,
          container: backend === "browser" ? "webm" : "mp4",
          codec: backend === "browser" ? "vp9" : "h264",
          quality: quality === "preview" ? "draft" : quality === "cinematic" ? "high" : quality,
        } : null,
        artifacts: [...new Set([
          ...outputs,
          "trace" as const,
          "manifest" as const,
        ])],
        staticSemantics: false,
        // CARLA renders are review-grade evidence; the other engines produce dataset-grade output.
        fidelity: backend === "carla" ? "review" : "dataset",
        environment: renderEnvironment,
      });
      const { revisionId, executionPackageId } = await ensureExecutionPackage();
      setStage("submit");
      const job = await studioHost.jobs.submitRenderIntent({
        schema: "uniscenario.render-intent-submission/v1",
        engine: backend,
        revisionId,
        executionPackageId,
        renderSpec,
        idempotencyKey: `render-intent:${revisionId}:${crypto.randomUUID()}`,
      });
      onManagedJobCreated(job.id);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "The render could not be submitted.");
    } finally {
      setStage(null);
      setPackageWait(null);
    }
  }

  async function submitEsminiRun() {
    if (stage != null) return;
    setSubmitError(null);
    setStage("package");
    try {
      // The esmini validator executes the same frozen execution package the CARLA path renders, so
      // the export must exist before the run is queued — the CPU claim gates on a succeeded export.
      const { revisionId } = await ensureExecutionPackage();
      setStage("submit");
      await studioHost.jobs.createValidationRun({
        revisionId,
        validatorKind: "esmini",
        validatorVersion: ESMINI_VALIDATOR_VERSION,
        idempotencyKey: `esmini:${revisionId}:${crypto.randomUUID()}`,
      });
      onEsminiRunCreated();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "The esmini run could not be submitted.");
    } finally {
      setStage(null);
      setPackageWait(null);
    }
  }

  const engineOption = ENGINE_OPTIONS.find((option) => option.id === backend)!;

  return (
    <section
      aria-label="New render configuration"
      className="render-view-enter flex min-h-0 flex-1 flex-col overflow-hidden"
      data-render-engine={backend}
      data-render-step={step.id}
      data-testid="render-config-panel"
    >
      <header className="relative flex shrink-0 items-center justify-between gap-4 border-b render-hairline px-6 py-3">
        <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/70 via-primary/15 to-transparent" />
        <div className="flex min-w-0 items-center gap-3">
          <button
            aria-label="Back to the render gallery"
            className="editor-motion grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="render-config-back"
            onClick={onClose}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </button>
          <div className="min-w-0">
            <p className="font-mono text-micro font-bold uppercase tracking-meta text-primary/90">New render</p>
            <h2 className="text-base font-extrabold leading-tight tracking-tight text-foreground">
              {engineOption.label}
            </h2>
          </div>
        </div>
        <RenderWizardStepRail
          activeIndex={steps.indexOf(step)}
          onSelect={setStepIndex}
          steps={steps}
        />
      </header>

      {step.id === "engine" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              hint="Renderers run on registered GPU workers. You can close this tab after submission."
              title="How should this scenario be rendered?"
            />
            <div aria-label="Render engine" className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {ENGINE_OPTIONS.filter((option) =>
                // Engines this host will reject are not choices. Until the host has answered,
                // every card stays visible but disabled rather than pretending nothing exists.
                hostCapabilitiesState.status !== "ready" || engineAvailability(option.id, hostCapabilities).offered,
              ).map((option) => {
                const availability = engineAvailability(option.id, hostCapabilities);
                return (
                  <RenderOptionCard
                    badge={availability.badge}
                    disabled={!availability.offered}
                    hint={availability.reason ?? option.hint}
                    icon={option.icon}
                    key={option.id}
                    label={option.label}
                    onClick={() => selectBackend(option.id)}
                    selected={backend === option.id}
                    selection="single"
                    testId={`render-backend-${option.id}`}
                  />
                );
              })}
            </div>
            {hostBlock !== null ? (
              <p className="mt-5 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground" data-testid="render-host-block">
                {hostBlock}
              </p>
            ) : backend !== "esmini" ? (
              <p className="mt-5 border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                SimForge owns execution; the host persists the immutable intent, lease and progress.
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note={backend === "esmini"
              ? "Runs on the CPU job fleet — no GPU worker required."
              : `${clipSeconds}s frozen scenario · registered ${backend} GPU lane`}
            onNext={() => setStepIndex(1)}
          />
        </>
      ) : backend === "esmini" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              hint={`Fixed 0.02 s timestep, pinned seed, esmini ${ESMINI_VALIDATOR_VERSION}.`}
              title="Replay the frozen export and check it"
            />
            <p className="render-glass border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              The frozen revision&apos;s OpenSCENARIO 1.4 export and its OpenDRIVE road network are
              replayed headlessly. It is a cross-engine check of the exported scenario — no cameras,
              no imagery.
            </p>
            <ul className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2">
              <li className="flex items-baseline justify-between gap-2 render-glass border px-3 py-2">
                <span className="font-semibold text-foreground">State trace</span>
                <span className="text-micro text-muted-foreground">CSV · pose and speed per step</span>
              </li>
              <li className="flex items-baseline justify-between gap-2 render-glass border px-3 py-2">
                <span className="font-semibold text-foreground">Validation report</span>
                <span className="text-micro text-muted-foreground">JSON · XSD, entities, collisions</span>
              </li>
            </ul>
            {submitError ? (
              <p className="mt-3 break-words text-xs text-destructive" role="alert">
                {submitError}
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note="Runs on the CPU job fleet — no GPU worker required."
            onBack={() => setStepIndex(0)}
            primary={
              <button
                className={cn(
                  "editor-motion inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  stage != null
                    ? "cursor-not-allowed render-glass border text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                data-testid="esmini-run-button"
                disabled={stage != null}
                onClick={() => void submitEsminiRun()}
                type="button"
              >
                {stage != null ? (
                  <>
                    <CloudActivityIndicator />
                    {stage === "package" ? "Preparing package…" : "Submitting…"}
                  </>
                ) : (
                  <>
                    <FlaskConical aria-hidden="true" className="size-3.5" />
                    Run esmini
                  </>
                )}
              </button>
            }
          />
        </>
      ) : step.id === "cameras" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              aside={sensorOptions.length > 0
                ? `${selectedSensors.length}/${sensorOptions.length} selected`
                : "None configured"}
              hint={backend === "carla"
                ? "Supported modalities follow each sensor. The CARLA worker's preflight decides whether the selection fits its hardware."
                : backend === "native"
                  ? "Select authored RGB cameras for the receipt-validated native master scene."
                  : "Choose the authored sensors and modalities this browser render should capture."}
              title={`Which sensors should ${engineOption.label} capture?`}
            />
            {sensorOptions.length > 0 ? (
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {sensorOptions.map((option) => {
                  const key = sensorOptionKey(option);
                  return (
                    <div
                      className={cn(
                        "editor-motion border px-3 py-2",
                        selectedSensorKeys.includes(key)
                          ? "border-primary bg-primary/10"
                          : "render-glass",
                      )}
                      key={key}
                    >
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          checked={selectedSensorKeys.includes(key)}
                          className="mt-0.5 size-3.5 accent-primary"
                          data-testid={`render-sensor-${option.sensor.id}`}
                          disabled={stage != null}
                          onChange={(event) => toggleSensor(key, event.target.checked)}
                          type="checkbox"
                        />
                        <Camera aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-foreground">
                            {sensorLabel(option.sensor)}
                          </span>
                          <span className="block truncate text-micro uppercase tracking-meta text-muted-foreground">
                            {sensorDetail(option)}
                          </span>
                        </span>
                      </label>
                      <div className="mt-2 flex flex-wrap gap-1 pl-6">
                        {(backend === "native" ? ["rgb" as const] : supportedModalities(option.sensor)).map((modality) => {
                          const enabled = modalitiesBySensor[key]?.includes(modality) ?? false;
                          return (
                            <button
                              aria-pressed={enabled}
                              className={cn(
                                "border px-1.5 py-0.5 text-micro uppercase tracking-meta",
                                enabled ? "border-primary bg-primary text-primary-foreground" : "render-glass text-muted-foreground",
                              )}
                              disabled={stage != null || !selectedSensorKeys.includes(key)}
                              key={modality}
                              onClick={() => toggleSensorModality(key, modality)}
                              type="button"
                            >
                              {renderModalityLabel(modality)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground">
                Add a camera, LiDAR or radar to an actor in the editor before rendering.
              </p>
            )}
            <div className="mt-4">
              <StepHeading hint="What each selected sensor produces." title="Kinds" />
              <div className="flex flex-wrap gap-1.5">
                {SENSOR_KINDS.filter((kind) => backend !== "native" || kind.id === "rgb").map((kind) => {
                  const enabled = kinds.includes(kind.id);
                  return (
                    <button
                      aria-pressed={enabled}
                      className={cn(
                        "editor-motion border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        enabled
                          ? "border-primary bg-primary text-primary-foreground"
                          : "render-glass text-muted-foreground hover:text-foreground",
                      )}
                      key={kind.id}
                      onClick={() => toggleKind(kind.id)}
                      title={kind.hint}
                      type="button"
                    >
                      {kind.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${physicalSensors} physical sensors · ${sensorCount} modality sources`}
            nextDisabled={sensorCount === 0}
            onBack={() => setStepIndex(0)}
            onNext={() => setStepIndex(2)}
          />
        </>
      ) : step.id === "output" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              aside={`${outputs.length} selected`}
              hint="A behavior trace, manifest and parity report are always included as run evidence."
              title="What should the render return?"
            />
            <div className="grid gap-1.5 sm:grid-cols-3">
              {OUTPUT_OPTIONS.filter((option) => backend !== "native" || option.id === "video").map((option) => (
                <RenderOptionCard
                  hint={option.hint}
                  key={option.id}
                  label={option.label}
                  onClick={() => toggleOutput(option.id)}
                  selected={outputs.includes(option.id)}
                  selection="multi"
                  testId={`render-output-${option.id}`}
                />
              ))}
            </div>
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${outputs.length} selected · durable worker submission`}
            nextDisabled={outputs.length === 0}
            onBack={() => setStepIndex(1)}
            onNext={() => setStepIndex(3)}
          />
        </>
      ) : step.id === "settings" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              hint="These settings are stored in the immutable render intent without changing the scenario draft."
              title="How should this render look and run?"
            />
            <div className="grid gap-5 lg:grid-cols-[1fr_1.25fr]">
              <section>
                <StepHeading hint="Applies to every image sensor in the request." title="Format" />
                <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-micro uppercase tracking-meta text-muted-foreground">Resolution</span>
                    <select
                      className="render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={stage != null}
                      onChange={(event) => setResolutionIndex(Number(event.target.value))}
                      value={String(resolutionIndex)}
                    >
                      {resolutions.map((item, index) => (
                        <option key={item.label} value={String(index)}>
                          {item.label} ({item.width}×{item.height})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-micro uppercase tracking-meta text-muted-foreground">FPS</span>
                    <select
                      className="render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={stage != null}
                      onChange={(event) => setFps(Number(event.target.value))}
                      value={String(fps)}
                    >
                      {fpsOptions.map((value) => (
                        <option key={value} value={String(value)}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-micro uppercase tracking-meta text-muted-foreground">Quality</span>
                    <select
                      className="render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={stage != null}
                      onChange={(event) => setQuality(event.target.value as (typeof CARLA_QUALITIES)[number])}
                      value={quality}
                    >
                      {CARLA_QUALITIES.map((value) => (
                        <option className="capitalize" key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-5 flex items-center gap-2 border border-primary/30 bg-primary/5 px-3 py-2">
                  <Clock aria-hidden="true" className="size-3.5 shrink-0 text-primary/80" />
                  <p className="text-xs text-foreground">
                    {durationSeconds}s
                    <span className="ml-2 text-micro font-normal uppercase tracking-meta text-muted-foreground">
                      durable submission — closing this tab does not stop the worker
                    </span>
                  </p>
                </div>
              </section>
              <RenderSettingsFields
                disabled={stage != null}
                durationSeconds={durationSeconds}
                environment={renderEnvironment}
                maxDurationSeconds={clipSeconds}
                onDurationChange={setDurationSeconds}
                onEnvironmentChange={setRenderEnvironment}
              />
            </div>
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${resolution.label} · ${fps} fps · ${quality} · ${renderEnvironment.weather.replaceAll("_", " ")}`}
            onBack={() => setStepIndex(2)}
            onNext={() => setStepIndex(4)}
          />
        </>
      ) : (
        <>
          <RenderWizardBody>
            <StepHeading
              hint="Submitting freezes the scenario and persists one immutable SimForge render intent."
              title={`Ready to render with ${engineOption.label}`}
            />
            <dl className="render-glass border px-3 py-1.5">
              <ReviewRow label="Engine" value={`${engineOption.label} · registered GPU worker`} />
              <ReviewRow
                label="Sensors"
                value={selectedSensors.length > 0
                  ? selectedSensors.map((option) => sensorLabel(option.sensor)).join(", ")
                  : "None selected"}
              />
              <ReviewRow label="Kinds" value={selectedKinds.length > 0 ? selectedKinds.join(", ") : "None enabled"} />
              <ReviewRow label="Format" value={`${resolution.label} · ${fps} fps · ${quality}`} />
              <ReviewRow label="Environment" value={`${renderEnvironment.weather.replaceAll("_", " ")} · ${renderEnvironment.timeOfDay.replaceAll("_", " ")}`} />
              <ReviewRow label="Outputs" value={outputs.length > 0 ? outputs.join(", ") : "None"} />
              <ReviewRow label="Duration" value={`${durationSeconds}s of ${clipSeconds}s`} />
              <ReviewRow
                label="Sensor hosts"
                value={sensorHostAssets.length > 0 ? sensorHostAssets.join(", ") : "No bound host asset"}
              />
            </dl>
            {backend === "carla" ? (
              <section
                aria-labelledby="render-warnings-heading"
                className="mt-3 border border-amber-500/45 bg-amber-500/10 px-3 py-2.5"
                data-testid="render-warnings"
              >
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                  <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                  <h3
                    className="text-micro font-bold uppercase tracking-meta"
                    id="render-warnings-heading"
                  >
                    Warnings
                  </h3>
                </div>
                {carlaWarnings.status === "ready" && carlaWarnings.warnings.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {carlaWarnings.warnings.map((warning) => (
                      <li
                        className="grid grid-cols-[auto_1fr] gap-x-2 text-xs"
                        key={`${warning.kind}:${warning.actorId}:${warning.authoredCatalogId}`}
                      >
                        <span className="font-mono text-micro font-bold uppercase text-amber-700 dark:text-amber-300">
                          {warning.kind === "drop" ? "Dropped" : "Substituted"}
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">
                            {warning.actorLabel}
                            <span className="ml-1 font-mono text-micro font-normal text-muted-foreground">
                              {warning.authoredCatalogId}
                              {warning.substituteCatalogId ? ` → ${warning.substituteCatalogId}` : ""}
                            </span>
                          </p>
                          <p className="text-muted-foreground">{warning.reason}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {carlaWarnings.status === "ready"
                      ? "No known CARLA actor limitations."
                      : carlaWarnings.status === "error"
                        ? `CARLA actor compatibility could not be checked: ${carlaWarnings.message}`
                        : "Checking CARLA actor compatibility…"}
                  </p>
                )}
                <p className="mt-2 text-micro text-muted-foreground">
                  Informational only — you can still submit this render.
                </p>
              </section>
            ) : null}
            {issues.length > 0 ? (
              <div
                className="mt-3 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="render-config-issues"
              >
                {issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            ) : null}
            {stage !== null ? (
              // Submitting takes two waits an author cannot otherwise see: freezing the revision and
              // then a compile they are queued behind. Naming which one, and how long, is the
              // difference between a slow pipeline and an apparently dead button.
              <section
                aria-live="polite"
                className="mt-3 render-glass border p-3"
                data-testid="render-submit-progress"
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  <CloudActivityIndicator />
                  <span className="min-w-0 flex-1 truncate">
                    {stage === "package"
                      ? packageWait === null
                        ? "Freezing the scenario into an immutable revision"
                        : `Compiling the execution package · export ${packageWait.status}`
                      : "Submitting to the GPU fleet"}
                  </span>
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {formatElapsed(
                      new Date(packageWait?.startedAtMs ?? nowMs).toISOString(),
                      new Date(nowMs).toISOString(),
                    )}
                  </span>
                </div>
                {packageWait !== null ? (
                  <p className="mt-1.5 text-micro text-muted-foreground" data-testid="render-submit-export">
                    {packageWait.claimed
                      ? "A compiler has it and is working."
                      : "Waiting for an OpenSCENARIO compiler to pick it up."}
                    <span className="ml-1 font-mono opacity-80">{packageWait.exportId}</span>
                  </p>
                ) : null}
              </section>
            ) : null}
            {submitError ? (
              <p className="mt-3 break-words text-xs text-destructive" role="alert">
                {submitError}
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${physicalSensors} physical sensors · ${sensorCount} modality sources · reconnectable`}
            onBack={() => setStepIndex(3)}
            primary={
              <button
                className={cn(
                  "editor-motion inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  submitDisabled
                    ? "cursor-not-allowed render-glass border text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                data-testid="render-run-button"
                disabled={submitDisabled}
                onClick={() => void submitGpuRender()}
                type="button"
              >
                {stage != null ? (
                  <>
                    <CloudActivityIndicator />
                    {stage === "package" ? "Preparing package…" : "Submitting…"}
                  </>
                ) : (
                  <>
                    <Sparkles aria-hidden="true" className="size-3.5" />
                    Create render
                  </>
                )}
              </button>
            }
          />
        </>
      )}
    </section>
  );
}
