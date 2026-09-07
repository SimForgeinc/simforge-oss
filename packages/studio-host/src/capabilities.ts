import type { ScenarioJobFamily, ScenarioRendererEngine } from "./contracts";

export const STUDIO_HOST_CAPABILITIES_SCHEMA = "simforge.studio-host-capabilities/v1" as const;

/** Runtime manifest the runner prints from `simforge-runner runtime show`. */
export const NATIVE_RUNTIME_MANIFEST_SCHEMA = "simforge.native-runtime/v1" as const;

export type NativeRuntimeEngineDescriptor = {
  workload: string;
  backendProfiles: string[];
  requiresGpu: boolean;
  supportsContinuation: boolean;
};

export type NativeRuntimeSupportTier = {
  tier: string;
  description: string;
  requires: Record<string, string>;
  qualification: {
    status: "qualified" | "unqualified";
    blockers?: string[];
    evidence?: string;
    observed?: string[];
  };
};

export type NativeRuntimeManifest = {
  schema: typeof NATIVE_RUNTIME_MANIFEST_SCHEMA;
  runtimeId: string;
  version: string;
  revision: string;
  target: string;
  binary: { sha256: string; sizeBytes: number };
  engines: NativeRuntimeEngineDescriptor[];
  supportTiers: NativeRuntimeSupportTier[];
};

/**
 * Whether the native runner (`simforge-runner`) is installed and usable on the
 * host. `unavailable` is a first-class state the UI must render as such; the
 * host never fabricates an installed runtime.
 */
export type NativeRuntimeCapability =
  | {
      state: "unavailable";
      /** Machine code from the probe: not installed, manifest missing/invalid, probe failed. */
      code: "not_installed" | "runtime.manifest_missing" | "runtime.manifest_invalid" | "probe_failed" | "not_offered";
      reason: string;
      /** Locations the host consulted, in order, so the user can install into one of them. */
      searchedPaths: string[];
    }
  | {
      state: "available";
      binaryPath: string;
      runtime: NativeRuntimeManifest;
    };

export type StudioHostKind = "local" | "cloud";

export type StudioHostIdentity = {
  /** `fixed-local`: one implicit owner; `account`: authenticated cloud session. */
  mode: "fixed-local" | "account";
  userId: string;
  workspaceId: string;
  organizationId: string | null;
  displayName: string | null;
};

export type StudioHostPersistence =
  | { kind: "pglite-filesystem"; dataRoot: string }
  | { kind: "managed-postgres-object-storage" };

export type RenderWorkerCapability = {
  /** A registered, healthy worker for this engine is currently accepting jobs. */
  available: boolean;
  reason: string | null;
};

/** One executable or immutable asset a local render engine depends on, as found (or not) on this machine. */
export type LocalRenderDependency = {
  state: "available" | "missing";
  /** Resolved absolute path when available. */
  path: string | null;
  /** Where it was found: explicit environment, runtime manifest/root, PATH, or a launcher-managed install. */
  source: "env" | "runtime-manifest" | "runtime-root" | "path" | "playwright" | null;
};

/**
 * The local machine's ability to run the native (Bevy) render engine itself,
 * reported only by hosts that execute renders on the machine they run on.
 * `ready` requires every dependency present AND the local worker attached;
 * `reasons` names what is missing. Absent on hosts whose render lanes are
 * managed capacity.
 */
export type LocalRenderCapability = {
  engine: "native";
  ready: boolean;
  runtimeRoot: string;
  renderService: LocalRenderDependency;
  encoder: LocalRenderDependency;
  actorAssets: LocalRenderDependency & { digest: string };
  worker: {
    /** A local worker has polled this host within its liveness window. */
    attached: boolean;
    workerId: string | null;
    lastSeenAt: string | null;
    /** Engines that worker offered on its last poll. */
    engines: ScenarioRendererEngine[];
  };
  reasons: string[];
};

export type StudioHostCapabilities = {
  schema: typeof STUDIO_HOST_CAPABILITIES_SCHEMA;
  host: { kind: StudioHostKind; label: string; version: string | null };
  identity: StudioHostIdentity;
  persistence: StudioHostPersistence;
  execution: {
    /** The shared browser engine/viewport always runs where the UI runs. */
    browserSimulation: true;
    /**
     * Engines this host's render submission accepts, keyed by engine. A key's presence means the
     * host offers the engine; its value says whether healthy capacity exists right now. A missing
     * key is an unsupported engine, which the UI must never submit.
     */
    renderWorkers: Partial<Record<ScenarioRendererEngine, RenderWorkerCapability>>;
    nativeRuntime: NativeRuntimeCapability;
    /** Present only on hosts that render on this machine; see {@link LocalRenderCapability}. */
    localRender?: LocalRenderCapability;
  };
  jobs: {
    families: readonly ScenarioJobFamily[];
    /**
     * Leased jobs keep executing when the UI window closes. True only when the host process
     * outlives the UI (a detached service); false when the shell stops the host it started.
     * Persisted jobs are requeued either way, but that is retry, not uninterrupted execution.
     */
    survivesUiClose: boolean;
  };
};
