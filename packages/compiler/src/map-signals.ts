/**
 * Production map traffic-signal binding documents.
 *
 * RoadRunner's checked-in OpenDRIVE files provide physical head ids,
 * controller membership, junction/controller sequence order and concrete gate
 * geometry, but not authoritative phase durations. The native compiler
 * (`simforge-compiler::map_signals`) parses the catalog, applies map speed
 * limits and binds real heads/controllers to engine programs with the
 * deterministic `synthetic-default` timing; these are the shapes it emits
 * (`MapBundle.signalCatalog`, `MapBundle.controlPlan()`).
 */

import type { RoadControl, SignalProgram } from '@simforge-oss/engine';

export interface MapSignalHead {
  readonly id: string;
  readonly roadId: string;
  readonly s: number;
  readonly dynamic: boolean;
}

export interface MapRoadControlHead {
  readonly id: string;
  readonly kind: 'stop';
  readonly roadId: string;
  readonly s: number;
}

export interface MapSpeedLimitHead {
  readonly id: string;
  readonly roadId: string;
  readonly s: number;
  readonly speedLimitKph: number;
}

/** OpenDRIVE lane applicability for a physical signal head. A head can be
 * declared once and referenced from several junction movements. */
export interface MapSignalApplicability {
  readonly headId: string;
  readonly roadId: string;
  readonly fromLane: number | null;
  readonly toLane: number | null;
  readonly source: 'signal' | 'signal-reference';
}

export interface MapSignalController {
  readonly id: string;
  readonly sequence: number;
  readonly signalIds: readonly string[];
}

export interface MapSignalJunction {
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
}

export interface MapSignalCatalog {
  readonly heads: readonly MapSignalHead[];
  readonly roadControls: readonly MapRoadControlHead[];
  readonly speedLimits: readonly MapSpeedLimitHead[];
  readonly applicability: readonly MapSignalApplicability[];
  readonly controllers: readonly MapSignalController[];
  readonly junctions: readonly MapSignalJunction[];
}

/** An authored signal reference: a concrete program/head handle, or a matched feature approach. */
export type SiteSignalRef =
  | { readonly handle: string }
  | { readonly featureId: string; readonly approach: 'subject' | 'opposing' | 'left' | 'right' };

export interface SiteSignalPlan {
  readonly junctionId: string | null;
  readonly programs: readonly SignalProgram[];
  /** Physical map head id → concrete engine program id. */
  readonly programByHeadId: Readonly<Record<string, string>>;
  /** Junction connecting lane → concrete engine program ids. */
  readonly programsByConnectingLane: Readonly<Record<string, readonly string[]>>;
  readonly timingSource: 'synthetic-default' | 'none';
  /** Where the phase visible at t=0 comes from. The map has no live state. */
  readonly stateSource: 'synthetic-cycle' | 'none';
}

/** Map-wide physical controls used by the editor's scenario-independent
 * ambient world. Programs retain the exact OpenDRIVE head/controller ids; only
 * their timing is the documented deterministic fallback used by site plans. */
export interface MapControlPlan {
  readonly signalPrograms: readonly SignalProgram[];
  readonly roadControls: readonly RoadControl[];
}

export type SignalControlDiagnosticCode =
  | 'unresolved_head'
  | 'unresolved_movement'
  | 'shared_head'
  | 'conflicting_controller_stage'
  | 'missing_controller_stage';

/** One diagnostic from the native signal control index (`simforge-compiler::signal_plan`). */
export interface SignalControlDiagnostic {
  readonly code: SignalControlDiagnosticCode;
  readonly message: string;
  readonly headIds?: readonly string[];
  readonly movementIds?: readonly string[];
  readonly controllerIds?: readonly string[];
}

/** The executable movement grain: one program, one phase at `t`, possibly several lane pairs. */
export interface SignalMovementBinding {
  readonly id: string;
  readonly programId: string;
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
  readonly headIds: readonly string[];
  readonly approachLaneRsls: readonly string[];
  readonly connectingLaneRsls: readonly string[];
}

export interface SignalControllerBinding {
  readonly id: string;
  readonly junctionId: string;
  readonly headIds: readonly string[];
  readonly movementIds: readonly string[];
}

export interface SignalHeadControlBinding {
  readonly id: string;
  readonly junctionIds: readonly string[];
  readonly controllerIds: readonly string[];
  readonly movementIds: readonly string[];
  /** False means the physical head exists but no exact program/controller owns it. */
  readonly resolved: boolean;
}

export interface SignalJunctionControlBinding {
  readonly id: string;
  readonly controllerIds: readonly string[];
  readonly movementIds: readonly string[];
  readonly headIds: readonly string[];
}

/**
 * Exact reverse indices over the map control plan, keyed by id. Built natively
 * from executable programs and their preserved OpenDRIVE controller-stage
 * metadata; no geometric/proximity inference occurs.
 */
export interface SignalControlIndex {
  readonly heads: Readonly<Record<string, SignalHeadControlBinding>>;
  readonly movements: Readonly<Record<string, SignalMovementBinding>>;
  readonly controllers: Readonly<Record<string, SignalControllerBinding>>;
  readonly junctions: Readonly<Record<string, SignalJunctionControlBinding>>;
  readonly diagnostics: readonly SignalControlDiagnostic[];
}
