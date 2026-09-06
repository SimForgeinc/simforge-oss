/**
 * Signal-state documents the native engine publishes.
 *
 * Programs are executed, and stop-line authority is arbitrated, inside the
 * native runtime (`EnvSession.signalBookJson()`, `Simulation.signalStateJson()`,
 * the world-session truth stream). These are the wire shapes those calls
 * return; nothing here evaluates a timeline.
 */

import type { LaneRsl } from './map/topology.js';
import type { ControlIndication } from './schema/input.js';

export type SignalPhase = ControlIndication;

/** The law a dark head reverts to when the author has not said otherwise. */
export const DEFAULT_DARK_FALLBACK = 'all_way_stop' as const;
/** Standstill required at a dark or flashing-red line when unspecified, seconds. */
export const DEFAULT_DARK_DWELL_S = 1;
/** Tick rate every tick-denominated {@link SignalSnapshot} field assumes; the engine's fixed step. */
export const SIGNAL_SNAPSHOT_TICK_HZ = 50;

/** Observable phase plus the source that currently owns it. */
export interface SignalState {
  readonly phase: SignalPhase;
  readonly source: 'program' | 'override';
  readonly timingSource: 'map' | 'synthetic-default' | 'authored';
}

/** What law a stop line is executing **right now**. */
export interface StopLineAuthority {
  readonly kind: 'signal' | 'stop' | 'none';
  /** Minimum continuous standstill before release. Meaningful when `kind` is `stop`. */
  readonly dwellS: number;
  /** Why this authority applies, for the trace and for a human reading a failure. */
  readonly reason: 'program' | 'blackout' | 'flashing_red' | 'static_stop' | 'blackout_uncontrolled';
}

/**
 * Public, wire-ready truth about one signal at one instant — everything a
 * consumer outside the engine (scene stream, SPaT encoder, renderer overlay)
 * needs to reproduce the head's behaviour without re-implementing the law.
 */
export interface SignalSnapshot {
  readonly signalId: string;
  /** Physical heads this program drives, sorted. */
  readonly headIds: readonly string[];
  /** First OpenDRIVE controller id bound to this program, when known. */
  readonly controllerId: string | null;
  readonly junctionId: string | null;
  readonly phase: SignalPhase;
  /** `program` cycles on the authored timeline; `override` pins an external phase. */
  readonly source: 'program' | 'override';
  readonly timingSource: 'map' | 'synthetic-default' | 'authored';
  /** Engine tick index of the current phase's boundaries, absolute simulation time; null when no transition is scheduled. */
  readonly phaseStartTick: number | null;
  readonly phaseEndTick: number | null;
  readonly remainingTicks: number | null;
  readonly nextPhase: SignalPhase | null;
  readonly cycleLengthTicks: number | null;
  /** Present only while the head is dark (`off`) or flashing red. */
  readonly failureState?: 'off' | 'flashing-red';
}

export interface StopLineBinding {
  readonly controlId: string;
  /** Shared junction arbitration key for static all-way-stop approaches. */
  readonly coordinationId: string;
  readonly kind: 'signal' | 'stop';
  readonly signalId: string | null;
  readonly dwellS: number;
  readonly rsl: LaneRsl;
  /** Arc length in the lane's **storage** direction. */
  readonly s: number;
  /** Empty means every movement; otherwise the route must contain one. */
  readonly connectingLaneRsls: readonly LaneRsl[];
}

/** One repair the native compiler applied while binding physical controls to coincident lane identities. */
export interface ControlBindingRepair {
  readonly source: 'signalPrograms' | 'roadControls';
  readonly controlId: string;
  readonly sourceRsl: string;
  readonly routeRsl: string;
  readonly distanceM: number;
}
