/**
 * Presentation model shared by the desktop app and the web portal.
 *
 * Two orthogonal axes, deliberately not collapsed into one enum:
 *
 * - **host** — where the UI runs (`browser` | `desktop`). It decides which
 *   surfaces exist: only the desktop has a local model store, maps, scenarios
 *   and native rendering.
 * - **execution** — where inference runs (`local` | `runpod`). A desktop user
 *   may run in the cloud; a browser user has no local option at all.
 *
 * Capability flags here control *presentation only*. Membership, artifact
 * access, model entitlement and spending limits are decided by the server, and
 * every refusal shown to the user comes from the server's own words when the
 * server is the one refusing.
 */

import type {
  ModelCatalogEntry,
  ModelExecutionEligibility,
  ModelFamilyId,
  ModelInstallState,
  ModelQuant,
} from "./model-catalog";
import { MODEL_CATALOG } from "./model-catalog";
import type { ComputeJobStatus } from "./contracts";

/** Highest precision first: what a user would pick if the hardware allowed it. */
const PRECISION_PREFERENCE: readonly ModelQuant[] = ["bf16", "fp8", "nf4"] as const;

/** Families in the order the launcher should consider them. */
const FAMILY_PREFERENCE: readonly ModelFamilyId[] = [
  "alpamayo-1.5",
  "alpamayo-1",
  "alpamayo-2-super",
] as const;

/**
 * The model, precision and execution target the launcher should open on.
 *
 * Derived from this machine's measured eligibility rather than from a constant,
 * because a static default is wrong on most machines: "1.5 at bf16" is a
 * supported offer that needs 24 GiB, so on a 16 GiB box it would open the form
 * on a combination that cannot run while a runnable one sits one row down.
 *
 * Local execution wins when any profile is actually qualified here, at the
 * highest such precision. Otherwise the highest supported precision plus cloud
 * execution, which is what the backend will accept. Nothing needs to be kept in
 * sync: when a measurement lands and flips a quant from pending to supported,
 * this follows.
 */
/** The family the launcher falls back to when nothing is qualified anywhere. */
const FALLBACK_FAMILY: ModelFamilyId = "alpamayo-1.5";

/**
 * The family's best precision: the highest supported offer, else the highest it
 * lists at all. Every family lists at least `bf16`, which is why that is the
 * final fallback rather than an invented value.
 */
export function highestOfferedQuant(family: ModelFamilyId): ModelQuant {
  const offers = MODEL_CATALOG[family].quants;
  for (const quant of PRECISION_PREFERENCE) {
    if (offers.some((offer) => offer.quant === quant && offer.status === "supported")) return quant;
  }
  for (const quant of PRECISION_PREFERENCE) {
    if (offers.some((offer) => offer.quant === quant)) return quant;
  }
  return "bf16";
}

export function preferredSelection(
  host: HostExecutionSnapshot,
  runtime: ModelRuntimeSnapshot | null,
): { family: ModelFamilyId; quant: ModelQuant; target: ExecutionTarget } {
  if (host.host === "desktop" && runtime) {
    for (const family of FAMILY_PREFERENCE) {
      for (const quant of PRECISION_PREFERENCE) {
        const eligibility = runtime.eligibility[runtimeKey(family, quant)];
        if (eligibility?.executionEligible) return { family, quant, target: "local" };
      }
    }
  }
  for (const family of FAMILY_PREFERENCE) {
    for (const quant of PRECISION_PREFERENCE) {
      const offered = MODEL_CATALOG[family].quants.find((offer) => offer.quant === quant);
      if (offered?.status === "supported") return { family, quant, target: "runpod" };
    }
  }
  // Nothing on this machine is qualified and no family lists a supported
  // precision, which should not happen — but the form still has to open on a
  // concrete choice, and the backend remains the authority on whether it runs.
  return { family: FALLBACK_FAMILY, quant: highestOfferedQuant(FALLBACK_FAMILY), target: "runpod" };
}

export type EvaluationHostKind = "browser" | "desktop";
export type ExecutionTarget = "local" | "runpod";

/**
 * The subset of the desktop host's capability report this UI needs.
 *
 * Structural on purpose: the web portal must not depend on the desktop host
 * package, and the desktop maps its `StudioHostCapabilities` onto this shape at
 * the boundary.
 */
export type HostExecutionSnapshot = {
  host: EvaluationHostKind;
  /** Null in the browser; the desktop reports whether its native runner exists. */
  nativeRuntime: { available: boolean; reason: string | null } | null;
  /** Whether a signed-in SimCloud workspace is available for cloud runs. */
  cloud: { connected: boolean; workspaceId: string | null; reason: string | null };
};

/**
 * The desktop model store's live view, keyed by `family:quant`.
 *
 * Absent in the browser, and an absent entry is not "not installed" — it is
 * "unknown", which the UI must not present as a negative claim about the user's
 * machine.
 */
export type ModelRuntimeSnapshot = {
  installs: Record<string, ModelInstallState | undefined>;
  /**
   * Whether each family's isolated runtime is provisioned, keyed by family.
   *
   * Separate from install state on purpose: weights and runtime are provisioned
   * by independent steps that fail independently, so `installed` does not imply
   * runnable. Offering a local run against an unprepared runtime fails at spawn.
   */
  prepared: Record<string, boolean | undefined>;
  eligibility: Record<string, ModelExecutionEligibility | undefined>;
  vault: { hfTokenPresent: boolean; hfTokenIdentity: string | null } | null;
};

export function runtimeKey(family: ModelFamilyId, quant: ModelQuant): string {
  return `${family}:${quant}`;
}

export type ExecutionOffer = {
  target: ExecutionTarget;
  available: boolean;
  /** Why this target cannot be used, in full sentences, or null when it can. */
  reasons: string[];
  /** Present but unqualified: offered nowhere, explained everywhere. */
  qualification: "qualified" | "qualification-pending" | "unsupported" | null;
};

/**
 * The two execution offers for a family/quant on this host.
 *
 * Local is refused for a stack of independent reasons — no desktop, no native
 * runtime, weights not installed, hardware not qualified — and the user is told
 * all of them at once rather than discovering them one failed run at a time.
 */
export function executionOffers(
  host: HostExecutionSnapshot,
  entry: ModelCatalogEntry,
  quant: ModelQuant,
  install: ModelInstallState | null,
  eligibility: ModelExecutionEligibility | null,
  /** `false` when the family's runtime is known to be unprepared; null when unknown. */
  runtimePrepared: boolean | null = null,
): ExecutionOffer[] {
  const localReasons: string[] = [];
  let qualification: ExecutionOffer["qualification"] = null;

  if (host.host === "browser") {
    localReasons.push(
      "This is the web portal. Local execution needs the SimForge desktop app, which manages the model store and the native runtime.",
    );
  } else {
    if (host.nativeRuntime && !host.nativeRuntime.available) {
      localReasons.push(
        host.nativeRuntime.reason ?? "The native runtime is not installed on this machine.",
      );
    }
    if (!install || install.state !== "installed") {
      localReasons.push(
        `${entry.displayName} (${quant}) is not installed. Download it in Models first — downloading is separate from being able to execute it.`,
      );
    } else if (runtimePrepared === false) {
      localReasons.push(
        `${entry.displayName}'s weights are installed but its runtime is not prepared. Prepare it in Models — the weights and the isolated runtime are provisioned separately, so one can be present without the other.`,
      );
    }
    if (eligibility) {
      qualification = eligibility.qualification;
      if (!eligibility.executionEligible) localReasons.push(...eligibility.reasons);
    } else if (entry.remoteOnly) {
      qualification = "qualification-pending";
      localReasons.push(
        `${entry.displayName} has no qualified local execution profile yet; it runs on managed cloud capacity.`,
      );
    }
  }

  const cloudReasons: string[] = [];
  if (!host.cloud.connected) {
    cloudReasons.push(
      host.cloud.reason ??
        "Sign in to a SimCloud workspace to run in the cloud. Cloud runs do not require downloading the weights.",
    );
  }

  return [
    {
      target: "local",
      available: localReasons.length === 0,
      reasons: localReasons,
      qualification,
    },
    {
      target: "runpod",
      available: cloudReasons.length === 0,
      reasons: cloudReasons,
      qualification: null,
    },
  ];
}

/** Visual weight of a job status. Named so consumers can key styles off it. */
export type JobStatusTone = "neutral" | "active" | "good" | "warn" | "bad";

export type JobStatusPresentation = {
  label: string;
  tone: JobStatusTone;
  /** True while the server may still change this job's status. */
  live: boolean;
  detail: string | null;
};

const JOB_STATUS_PRESENTATION: Record<ComputeJobStatus, JobStatusPresentation> = {
  queued: { label: "Queued", tone: "neutral", live: true, detail: null },
  dispatching: { label: "Dispatching", tone: "active", live: true, detail: null },
  dispatch_unknown: {
    label: "Dispatch unknown",
    tone: "warn",
    live: true,
    detail:
      "The submission response was lost. The server is reconciling with the provider before deciding; it will not submit a duplicate.",
  },
  running: { label: "Running", tone: "active", live: true, detail: null },
  cancelling: { label: "Cancelling", tone: "warn", live: true, detail: null },
  succeeded: { label: "Succeeded", tone: "good", live: false, detail: null },
  partial: {
    label: "Partial",
    tone: "warn",
    live: false,
    detail:
      "Retained evidence from an incomplete run. It is not a complete result and is not scored.",
  },
  failed: { label: "Failed", tone: "bad", live: false, detail: null },
  cancelled: { label: "Cancelled", tone: "neutral", live: false, detail: null },
};

export function jobStatusPresentation(status: ComputeJobStatus): JobStatusPresentation {
  return JOB_STATUS_PRESENTATION[status] ?? { label: status, tone: "neutral", live: false, detail: null };
}

const INSTALL_LABELS: Record<ModelInstallState["state"], string> = {
  not_installed: "Not installed",
  downloading: "Downloading",
  verifying: "Verifying digests",
  installed: "Installed",
  paused: "Paused",
  error: "Install failed",
};

export function installLabel(state: ModelInstallState): string {
  return INSTALL_LABELS[state.state];
}

/** Fraction 0..1 of the current install step, or null when it has no measure. */
export function installFraction(state: ModelInstallState): number | null {
  if (state.state === "downloading" || state.state === "paused") {
    return state.bytesTotal > 0 ? Math.min(1, state.bytesDone / state.bytesTotal) : null;
  }
  if (state.state === "verifying") {
    return state.filesTotal > 0 ? Math.min(1, state.filesDone / state.filesTotal) : null;
  }
  return state.state === "installed" ? 1 : null;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A cost bound, never a price. `unbenchmarked` bounds are labelled by the
 * caller; this only formats the range.
 */
export function formatCentsRange(low: number, high: number): string {
  return low === high ? formatCents(low) : `${formatCents(low)} – ${formatCents(high)}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const power = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** power;
  return `${value.toFixed(power === 0 ? 0 : value < 10 ? 1 : 0)} ${BYTE_UNITS[power]}`;
}

export function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Wall time between two ISO instants, formatted, or null when it is not known yet. */
export function elapsedSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

export function formatModelRef(family: ModelFamilyId, revision: string, quant: string): string {
  return `${family} · ${quant} · ${revision.slice(0, 12)}`;
}

/**
 * Idempotency key for a submission.
 *
 * It must be stable for one user intent so a retried submit cannot charge
 * twice, and distinct across intents so two genuine runs are not collapsed
 * into one. Hashing the ordered identity keeps it within the API's 200-character limit.
 */
export async function submissionIdempotencyKey(parts: {
  kind: string;
  artifactIds: string[];
  family: string;
  quant: string;
  revision: string;
  /** A nonce the form generates once per prepared submission. */
  attempt: string;
}): Promise<string> {
  const identity = JSON.stringify([
    parts.kind,
    parts.family,
    parts.quant,
    parts.revision,
    parts.artifactIds,
    parts.attempt,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `evaluation:${hex}`;
}
