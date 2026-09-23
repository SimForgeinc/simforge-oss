import {
  AMBIENT_TRAFFIC_EXTENSION_KEY as PROFILE_EXTENSION_KEY,
  AmbientTrafficProfileError,
  ambientProfileMissingDefault,
  ambientTrafficProfileForDocument,
  validateAmbientTrafficProfileExtension,
  contentHash,
  defaultAmbientTrafficProfile,
  offAmbientTrafficProfile,
  resolveAmbientTrafficProfile,
  type AmbientTrafficProvenance,
  type AmbientTrafficProfile,
  type ResolvedAmbientTrafficProfile,
} from '@simforge-oss/engine';

export {
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProfileForDocument,
  ambientProfileMissingDefault,
  AmbientTrafficProfileError,
  offAmbientTrafficProfile,
  validateAmbientTrafficProfileExtension,
  defaultAmbientTrafficProfile,
} from '@simforge-oss/engine';
export type { AmbientProfileMissingDefault } from '@simforge-oss/engine';
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY, type AmbientTrafficProviderId } from './provider';

/**
 * The profile an editor panel DISPLAYS for a document. A malformed stored
 * profile shows as `off` here (so the panel still renders and the author can
 * pick a valid one), while every simulation path resolves it with
 * `ambientTrafficProfileForDocument`, which refuses it with
 * `AmbientTrafficProfileError`. Never use this to feed a simulation.
 */
export function ambientTrafficProfileForEditor(document: {
  readonly simulation?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
} | null | undefined): ResolvedAmbientTrafficProfile {
  if (!document) return offAmbientTrafficProfile();
  try {
    return ambientTrafficProfileForDocument(document);
  } catch (error) {
    if (error instanceof AmbientTrafficProfileError) return offAmbientTrafficProfile();
    throw error;
  }
}

export const AMBIENT_TRAFFIC_STORAGE_KEY = 'uniscenarios.studio.ambient-traffic.v1';
/**
 * Execution-bearing SUMO preview preference. Unlike the generated-population
 * profile, this changes the physical map controller program and therefore must
 * participate in the authored execution digest.
 */
export const ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY = 'studio.ambientTraffic.acceleratedSignalCycles.v1';

export interface AmbientSignalCycleSettings {
  readonly acceleratedSignalCycles: boolean;
}

export const DEFAULT_AMBIENT_SIGNAL_CYCLE_SETTINGS: AmbientSignalCycleSettings = Object.freeze({
  acceleratedSignalCycles: false,
});

/** Legacy/missing/malformed values migrate fail-closed to real map timing. */
export function ambientSignalCycleSettingsFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): AmbientSignalCycleSettings {
  return {
    acceleratedSignalCycles: extensions?.[ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY] === true,
  };
}
export type AmbientTrafficPreset = ResolvedAmbientTrafficProfile['preset'];

/** Canonical evidence is reusable only when it represents the editable copy's effective world. */
export function canReuseVerifiedEvidenceForAmbient(
  profile: ResolvedAmbientTrafficProfile,
  evidence: AmbientTrafficProvenance | undefined,
): boolean {
  return profile.preset === 'off' || evidence?.profileHash === contentHash(profile);
}

/**
 * Editable scenarios without a stored choice get the deterministic City
 * population. A stored `off` profile remains authoritative, and malformed
 * values recover to the same visible authoring default.
 */
export function profileForPreset(
  preset: AmbientTrafficPreset,
  current: AmbientTrafficProfile = defaultAmbientTrafficProfile(),
): ResolvedAmbientTrafficProfile {
  if (preset === 'custom') {
    return resolveAmbientTrafficProfile({ ...current, version: 1, preset });
  }
  return resolveAmbientTrafficProfile({ version: 1, preset, seed: current.seed });
}

export function loadAmbientTrafficProfile(
  storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage,
): ResolvedAmbientTrafficProfile {
  if (!storage) return defaultAmbientTrafficProfile();
  try {
    const raw = storage.getItem(AMBIENT_TRAFFIC_STORAGE_KEY);
    if (!raw) return defaultAmbientTrafficProfile();
    return resolveAmbientTrafficProfile(JSON.parse(raw) as AmbientTrafficProfile);
  } catch {
    return defaultAmbientTrafficProfile();
  }
}

export function saveAmbientTrafficProfile(
  profile: AmbientTrafficProfile,
  storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(AMBIENT_TRAFFIC_STORAGE_KEY, JSON.stringify(resolveAmbientTrafficProfile(profile)));
  } catch {
    // Storage can be unavailable in private browsing; the in-memory preference still works.
  }
}

export function nextAmbientSeed(current: string | number, entropy = Date.now()): string {
  const ordinal = String(current).match(/^(.*?)-(\d+)$/);
  if (ordinal) return `${ordinal[1]}-${Number(ordinal[2]) + 1}`;
  return `ambient-${Math.max(0, Math.trunc(entropy)).toString(36)}`;
}

export interface AmbientPromotionCapability {
  readonly safe: boolean;
  readonly reason: string;
}

/**
 * Promotion must never guess at lane-path semantics. The current v2
 * scene_absolute role stores pose/lane anchoring but has no authored lane-path
 * field, so generated traffic remains preview-only until that contract exists.
 */
export function ambientPromotionCapability(routeLaneRsls: readonly string[]): AmbientPromotionCapability {
  if (routeLaneRsls.length === 0) return { safe: false, reason: 'This generated actor has no materialized lane route.' };
  return {
    safe: false,
    reason: 'Promotion is unavailable because a scene-absolute role cannot yet preserve the generated lane-path route without guessing.',
  };
}


/**
 * The density a traffic source starts with when the document has none: the
 * City preset with the legacy seed (`ambient-1`), i.e. exactly the implicit
 * default every document ran before ambient traffic defaulted to off (and the
 * profile staging QA exercised SUMO with).
 */
export const DEFAULT_TRAFFIC_SOURCE_PRESET = 'city' as const;

/**
 * The extension writes for an author choosing a traffic source. Choosing SUMO
 * (or City sim) on a document whose effective density is `off` would run a
 * traffic engine with nothing to generate (SUMO refuses it outright), so the
 * choice also sets {@link DEFAULT_TRAFFIC_SOURCE_PRESET}, keeping the seed.
 * A document that already has a density keeps its pinned profile; a malformed
 * one is left for validation to report rather than silently replaced.
 */
export function ambientTrafficSourceSelection(
  document: {
    readonly simulation?: unknown;
    readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  },
  provider: AmbientTrafficProviderId,
): Record<string, unknown> {
  const entries: Record<string, unknown> = { [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: provider };
  if (provider === 'off') return entries;
  const stored = validateAmbientTrafficProfileExtension(document.extensions);
  if (stored.kind === 'invalid') return entries;
  const current = stored.kind === 'valid'
    ? stored.profile
    : ambientProfileMissingDefault(document) === 'off' ? offAmbientTrafficProfile() : defaultAmbientTrafficProfile();
  if (current.preset !== 'off') return entries;
  entries[PROFILE_EXTENSION_KEY] = profileForPreset(DEFAULT_TRAFFIC_SOURCE_PRESET, current);
  return entries;
}
