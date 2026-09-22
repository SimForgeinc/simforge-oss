import type { ScenarioJobFamily, ScenarioRendererEngine } from "./contracts";

export const STUDIO_HOST_CAPABILITIES_SCHEMA = "simforge.studio-host-capabilities/v1" as const;

/**
 * The Studio host protocol this package speaks: the set of routes, request and
 * response shapes behind the capability document. Bump it whenever a client
 * built against the previous number could misread the host.
 *
 * Compatibility rule for version 1: EXACT MATCH. A host and a client agree only
 * when they speak the same number; there is no range, because no promise of
 * forward or backward compatibility has been made yet. The rule lives only in
 * {@link checkHostProtocolVersion}; every client calls it rather than comparing
 * numbers itself, so the rule cannot drift between shells.
 */
export const STUDIO_HOST_PROTOCOL_VERSION = 1;

/** Transports over which a host offers the protocol. HTTP is the canonical boundary. */
export const STUDIO_HOST_TRANSPORTS = ["http"] as const;
export type StudioHostTransport = (typeof STUDIO_HOST_TRANSPORTS)[number];

export type HostProtocolCheck =
  | { ok: true; protocolVersion: number }
  | {
      ok: false;
      /** Names both versions and which side is older, so the operator knows what to upgrade. */
      reason: string;
      olderSide: "host" | "client";
    };

/**
 * Whether a capability document comes from a host this client may talk to.
 * Fails closed: a document without an integer `protocolVersion` is a host that
 * predates versioning, which is older than every versioned client and is
 * refused as such, never accepted because it did not object.
 */
export function checkHostProtocolVersion(
  document: unknown,
  clientVersion: number = STUDIO_HOST_PROTOCOL_VERSION,
): HostProtocolCheck {
  const reported = document !== null && typeof document === "object" && "protocolVersion" in document
    ? document.protocolVersion
    : undefined;
  if (reported === undefined) {
    return {
      ok: false,
      olderSide: "host",
      reason: `host reports no Studio host protocol version (it predates protocol 1); this client speaks protocol ${clientVersion}. The host is older: upgrade the host`,
    };
  }
  if (typeof reported !== "number" || !Number.isInteger(reported)) {
    return {
      ok: false,
      olderSide: "host",
      reason: `host reports an unreadable Studio host protocol version (${JSON.stringify(reported)}); this client speaks protocol ${clientVersion}. Treating the host as older: upgrade the host`,
    };
  }
  if (reported < clientVersion) {
    return {
      ok: false,
      olderSide: "host",
      reason: `host speaks Studio host protocol ${reported}, this client speaks protocol ${clientVersion}. The host is older: upgrade the host`,
    };
  }
  if (reported > clientVersion) {
    return {
      ok: false,
      olderSide: "client",
      reason: `host speaks Studio host protocol ${reported}, this client speaks protocol ${clientVersion}. This client is older: upgrade the client`,
    };
  }
  return { ok: true, protocolVersion: reported };
}

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
  /** Name of the active workspace, distinct from the account's display name. */
  workspaceName?: string | null;
};

export type StudioHostPersistence =
  | { kind: "pglite-filesystem"; dataRoot: string }
  | { kind: "managed-postgres-object-storage" };
export type StudioHostAction = "transfer" | "driver-in-the-loop";

export type StudioHostActionCapability = {
  available: boolean;
  /** Human-readable explanation shown before an unavailable action is attempted. */
  reason: string | null;
};


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

export type NativeRenderInstallStep = {
  name: "sky-assets" | "runtime" | "encoder" | "actor-assets";
  state: "pending" | "running" | "done" | "failed";
  /** Latest progress line, the installed path, or the failure. */
  detail: string | null;
};

/**
 * Whether the native render engine's runtime is on this machine and, while
 * the host installs it, how far along that is. `installed` is the probe's
 * verdict, never inferred from a finished install.
 */
export type NativeRenderInstall = {
  state: "not-installed" | "installing" | "installed" | "failed";
  runtimeRoot: string;
  installed: boolean;
  /** What the probe still finds missing. */
  reasons: string[];
  steps: NativeRenderInstallStep[];
  error: string | null;
};

/**
 * Icons a host may name for a navigation entry it contributes.
 *
 * A name, not a component: the capability document is JSON over HTTP, and the
 * host that produces it has no way to hand the UI a React element. The union
 * is the contract — the UI ships exactly these icons, so a host cannot name
 * one that does not render. Extend it when a host needs another.
 */
export type StudioHostNavIcon = "UserRound" | "Users";

/**
 * A utility surface that exists because of THIS host, contributed to the
 * dashboard's navigation.
 *
 * Studio's own navigation is a constant: the three apps and the utilities that
 * every installation has. A host may have surfaces of its own — an account, a
 * tenant — that Studio cannot know about and must not hardcode. It names them
 * here instead of the shell forking the navigation module to add them.
 */
export type StudioHostNavItem = {
  href: string;
  label: string;
  /** One line, shown under the label in the app switcher. */
  description: string;
  icon: StudioHostNavIcon;
  /** Pathname prefix that marks this entry the active one. */
  matchPrefix: string;
};

export type StudioWorkerNode = {
  id: string;
  engines: readonly string[];
  capabilities: unknown;
  lastHeartbeatAt: string | null;
};

export type StudioHostCapabilities = {
  schema: typeof STUDIO_HOST_CAPABILITIES_SCHEMA;
  /** See {@link STUDIO_HOST_PROTOCOL_VERSION}; clients refuse the host on a mismatch before loading anything. */
  protocolVersion: number;
  /** See {@link STUDIO_HOST_TRANSPORTS}. */
  transports: readonly StudioHostTransport[];
  host: { kind: StudioHostKind; label: string; version: string | null };
  identity: StudioHostIdentity;
  persistence: StudioHostPersistence;
  /** Optional action-level availability; omitted by older hosts and treated as available. */
  actions?: Partial<Record<StudioHostAction, StudioHostActionCapability>>;
  /** See {@link StudioHostNavItem}; absent on hosts that add no surfaces of their own. */
  navItems?: readonly StudioHostNavItem[];
  execution: {
    /** The shared browser engine/viewport always runs where the UI runs. */
    browserSimulation: true;
    /**
     * Engines this host's render submission accepts, keyed by engine. A key's presence means the
     * host offers the engine; its value says whether healthy capacity exists right now. A missing
     * key is an unsupported engine, which the UI must never submit.
     */
    renderWorkers: Partial<Record<ScenarioRendererEngine, RenderWorkerCapability>>;
    /** Registered workers seen by the control plane or local CPU presence lane. */
    workerNodes: readonly StudioWorkerNode[];
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

/**
 * Whether this host runs somewhere other than the machine looking at it.
 *
 * The two axes that make a host remote are reported separately — it calls
 * itself `cloud`, and its storage is managed rather than a directory on this
 * disk — and either one is enough. Every surface that only means something on
 * the machine that owns the data asks this one question, so "what is a cloud
 * host" cannot be answered differently in two places.
 */
export function isCloudHost(capabilities: StudioHostCapabilities): boolean {
  return (
    capabilities.host.kind === "cloud" ||
    capabilities.persistence.kind === "managed-postgres-object-storage"
  );
}
