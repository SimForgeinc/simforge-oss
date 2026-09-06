/**
 * Ambient traffic profile — the authored, browser-safe configuration for
 * generated background road users, and the provenance/pool documents the
 * native compiler emits when it applies one.
 *
 * Candidate generation, selection and settling run in the native runtime
 * (`simforge-compiler::ambient`); this module only defines the documents that
 * cross that boundary.
 */

import { z } from 'zod';

import type { ActorKind, SimActor, SimScenarioInput } from '../schema/input.js';

/** Versioned, browser-safe configuration for generated background road users. */
export const ambientTrafficProfileSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.enum(['off', 'light', 'moderate', 'city', 'heavy', 'custom']).default('off'),
  /** Target moving road users per kilometre of eligible lane near the scenario. */
  densityVehiclesPerKm: z.number().finite().min(0).max(80).optional(),
  flows: z.object({
    through: z.number().finite().min(0).default(0.7),
    left: z.number().finite().min(0).default(0.12),
    right: z.number().finite().min(0).default(0.16),
    uTurn: z.number().finite().min(0).default(0.02),
  }).default({ through: 0.7, left: 0.12, right: 0.16, uTurn: 0.02 }),
  vehicleMix: z.object({
    car: z.number().finite().min(0).default(0.72),
    van: z.number().finite().min(0).default(0.1),
    truck: z.number().finite().min(0).default(0.08),
    bus: z.number().finite().min(0).default(0.04),
    motorcycle: z.number().finite().min(0).default(0.06),
  }).default({ car: 0.72, van: 0.1, truck: 0.08, bus: 0.04, motorcycle: 0.06 }),
  pedestrianShare: z.number().finite().min(0).max(1).default(0),
  cyclistShare: z.number().finite().min(0).max(1).default(0.04),
  aggressiveness: z.number().finite().min(0).max(1).default(0.35),
  speedVariance: z.number().finite().min(0).max(0.8).default(0.12),
  seed: z.union([z.string().min(1), z.number().int()]).default('ambient'),
  maxActors: z.number().int().min(0).max(128).default(40),
  /** Candidate selection is local to authored choreography, not the whole city. */
  radiusM: z.number().finite().min(25).max(2000).default(250),
  /** Empty road around authored starts and explicit reservations. */
  exclusionRadiusM: z.number().finite().min(2).max(100).default(12),
}).refine((profile) => profile.pedestrianShare + profile.cyclistShare <= 1, {
  path: ['cyclistShare'],
  message: 'pedestrianShare + cyclistShare must not exceed 1',
});

export type AmbientTrafficProfile = z.input<typeof ambientTrafficProfileSchema>;
export type ResolvedAmbientTrafficProfile = z.output<typeof ambientTrafficProfileSchema> & {
  densityVehiclesPerKm: number;
};

export interface AmbientReservation {
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
}

/** Options accepted by the native `materializeAmbientTraffic` (serialised as its `optionsJson`; unknown keys are rejected). */
export interface AmbientTrafficOptions {
  readonly reservations?: readonly AmbientReservation[];
  /** Lanes excluded from candidate placement in addition to the authored corridor. */
  readonly excludedLaneRsls?: readonly string[];
  /** Robustness evaluators only: allow traffic on the authored corridor. */
  readonly allowAuthoredCorridor?: boolean;
  /** Extra seconds of downstream runway every candidate must own. */
  readonly extraTravelSeconds?: number;
  /** Scale the density-derived placement target. */
  readonly targetMultiplier?: number;
  /** Widen the cohort exclusion radius, metres. */
  readonly cohortRadiusBonusM?: number;
}

export interface AmbientScreeningReason {
  readonly actorId: string;
  readonly reason: 'collision' | 'required_decel';
  readonly detail?: string;
  readonly requiredDecelMps2?: number;
  readonly maxAchievableDecelMps2?: number;
}

export interface AmbientActorProvenance {
  readonly id: string;
  readonly kind: ActorKind;
  readonly routeLaneRsls: readonly string[];
  readonly seedKey: string;
  readonly origin: 'ambient';
  readonly timelineVisible: false;
  readonly editable: false;
}

export interface AmbientTrafficProvenance {
  readonly version: 1;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly profileHash: string;
  /** Stable population identity. Authored choreography is deliberately absent. */
  readonly candidatePoolKey: string;
  readonly mapGraphDigest: string;
  readonly baseInputHash: string;
  readonly generatedInputHash: string;
  readonly actors: readonly AmbientActorProvenance[];
  readonly rejectedSpawnCount: number;
  /** Candidates dropped purely for touching the authored corridor. */
  readonly authoredCorridorRejects: number;
  /** The authored corridor that was reserved, sorted. */
  readonly authoredCorridorLaneRsls: readonly string[];
  readonly eligibleLaneKm: number;
  readonly placementTarget: number;
  /** Compatibility summary. Ordinary materialization never executes a screening clip. */
  readonly screening: {
    readonly evaluated: boolean;
    readonly passes: number;
    readonly maxAchievableDecelMps2: number | null;
    readonly count: number;
    readonly actorIds: readonly string[];
    readonly reasons: readonly AmbientScreeningReason[];
  };
  readonly warnings: readonly string[];
}

export interface AmbientTrafficResult {
  readonly input: SimScenarioInput;
  readonly provenance: AmbientTrafficProvenance;
}

export interface AmbientCandidate {
  readonly id: string;
  readonly actor: SimActor;
  readonly laneRsl: string;
  readonly routeLaneRsls: readonly string[];
  readonly seedKey: string;
  readonly footprintRadiusM: number;
  /** Runtime/editor ownership metadata; simulation still receives an ordinary SimActor. */
  readonly origin: 'ambient';
  readonly timelineVisible: false;
  readonly editable: false;
}

export interface AmbientCandidatePool {
  readonly version: 1;
  readonly key: string;
  readonly mapGraphDigest: string;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly profileHash: string;
  readonly candidates: readonly AmbientCandidate[];
}

const PRESET_DENSITY: Record<ResolvedAmbientTrafficProfile['preset'], number> = {
  off: 0,
  light: 3,
  moderate: 8,
  city: 8,
  heavy: 16,
  custom: 8,
};

/**
 * The City preset is deliberately car-heavy while still making sidewalks feel
 * inhabited. These are applied only when a field was not explicitly authored,
 * so a stored City profile remains a stable, editable scenario setting.
 */
const CITY_PRESET_DEFAULTS = {
  pedestrianShare: 0.06,
  cyclistShare: 0.02,
  aggressiveness: 0.25,
  speedVariance: 0.1,
  maxActors: 32,
  radiusM: 275,
  exclusionRadiusM: 16,
} as const;

export const AMBIENT_TRAFFIC_EXTENSION_KEY = 'studio.ambientTraffic.profile.v1';

export function defaultAmbientTrafficProfile(): ResolvedAmbientTrafficProfile {
  return resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'ambient-1' });
}

/** Read the canonical authored ambient profile used by browser and compiler. */
export function ambientTrafficProfileFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): ResolvedAmbientTrafficProfile {
  const value = extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY];
  if (value === undefined) return defaultAmbientTrafficProfile();
  try {
    return resolveAmbientTrafficProfile(value as AmbientTrafficProfile);
  } catch {
    return defaultAmbientTrafficProfile();
  }
}

/** Resolve defaults once so hashes and worker messages have one canonical shape. */
export function resolveAmbientTrafficProfile(profile: AmbientTrafficProfile): ResolvedAmbientTrafficProfile {
  const withPresetDefaults = profile.preset === 'city'
    ? { ...CITY_PRESET_DEFAULTS, ...profile }
    : profile;
  const parsed = ambientTrafficProfileSchema.parse(withPresetDefaults);
  return {
    ...parsed,
    densityVehiclesPerKm: parsed.densityVehiclesPerKm ?? PRESET_DENSITY[parsed.preset],
  };
}
