/**
 * Traffic-signal heads for the native renderer: which rendered head a
 * timeline signal drives, and which of its three lenses is lit.
 *
 * The render timeline names a head `signal:<OpenDRIVE signal id>`. The map
 * GLB names the head node `{guid}<asset>`, where `{guid}` is the RoadRunner
 * asset id the OpenDRIVE `<signal>` carries as `<userData><vectorSignal
 * signalId="{guid}"/>`. The binding is read from the job's OpenDRIVE (the
 * same document the sun is placed from). The renderer (`set_signal_lenses`)
 * shows the lit lens of the lamp the indication names and the unlit lens of
 * the others; before this every head drew all three lit lenses.
 */

import type { NativeSignalLens } from './lowering.js';

/** The timeline's signal-head key prefix (simforge-core, CARLA: `signal:<id>`). */
export const TIMELINE_SIGNAL_PREFIX = 'signal:';

/** Flash period and duty of `flashing_*` indications (render-timeline §Lights: on at t = 0). */
const FLASH_PERIOD_S = 1;
const FLASH_DUTY = 0.5;

export function flashOn(t: number): boolean {
  const phase = t - FLASH_PERIOD_S * Math.floor(t / FLASH_PERIOD_S);
  return phase < FLASH_PERIOD_S * FLASH_DUTY;
}

/**
 * OpenDRIVE signal id -> RoadRunner head GUID (lowercase, braced), for every
 * `<signal>` that names one. Zero-geometry debris signals carry no GUID.
 */
export function signalHeadGuids(xodr: string): Map<string, string> {
  const out = new Map<string, string>();
  const signal = /<signal\b([^>]*?)(\/>|>([\s\S]*?)<\/signal>)/gu;
  for (let match = signal.exec(xodr); match; match = signal.exec(xodr)) {
    const id = /\bid="([^"]+)"/u.exec(match[1] ?? '')?.[1];
    const guid = /<vectorSignal\b[^>]*\bsignalId="(\{[0-9a-fA-F-]{36}\})"/u.exec(match[3] ?? '')?.[1];
    if (id !== undefined && guid !== undefined) out.set(id, guid.toLowerCase());
  }
  return out;
}

/** Indications a three-lamp round-lens head shows only approximately. */
const SUBSTITUTED: Readonly<Record<string, NativeSignalLens>> = {
  green_arrow: 'green', proceed: 'green', yellow_arrow: 'yellow', red_x: 'red', stop: 'red',
};

/**
 * The lens a three-lamp head lights for a timeline indication at clip time
 * `t` (`flashing_*` phased on the timeline clock). `substituted` is set when
 * the indication is an arrow or control symbol the round lens cannot draw.
 */
export function signalLens(indication: string, t: number): { lens: NativeSignalLens; substituted: boolean } {
  switch (indication) {
    case 'red': case 'yellow': case 'green': return { lens: indication, substituted: false };
    case 'off': return { lens: 'off', substituted: false };
    case 'flashing_yellow': return { lens: flashOn(t) ? 'yellow' : 'off', substituted: false };
    case 'flashing_red': return { lens: flashOn(t) ? 'red' : 'off', substituted: false };
    case 'flashing_yellow_arrow': return { lens: flashOn(t) ? 'yellow' : 'off', substituted: true };
    case 'flashing_red_arrow': return { lens: flashOn(t) ? 'red' : 'off', substituted: true };
    default: {
      const lens = SUBSTITUTED[indication];
      if (!lens) throw new Error(`native_signal_indication_unknown: render timeline indication ${JSON.stringify(indication)}`);
      return { lens, substituted: true };
    }
  }
}

/** What binding a timeline's signals to rendered heads could not do as asked. */
export interface SignalBindingEvidence {
  /** Timeline signal ids with no rendered head (no `<vectorSignal>` GUID). */
  readonly unbound: readonly string[];
  /** Heads driven by more than one timeline signal whose lenses disagreed: guid -> ids. */
  readonly conflicts: ReadonlyMap<string, readonly string[]>;
  /** Indications shown on a round lens they do not match (`green_arrow` -> green, ...). */
  readonly substituted: readonly string[];
}

/**
 * Resolve one frame's `signals` for the service: head GUID -> lens.
 * `indications` is the timeline's `signals_at` (keys `signal:<id>`).
 * A head bound by several signal ids shows the lens of the smallest id; a
 * disagreement is recorded, never resolved in silence.
 */
export function resolveFrameSignals(
  indications: Readonly<Record<string, string>>,
  t: number,
  guids: ReadonlyMap<string, string>,
  evidence: { unbound: Set<string>; conflicts: Map<string, Set<string>>; substituted: Set<string> },
): Record<string, NativeSignalLens> {
  const out: Record<string, NativeSignalLens> = {};
  const owner = new Map<string, string>();
  for (const key of Object.keys(indications).sort()) {
    if (!key.startsWith(TIMELINE_SIGNAL_PREFIX) || key.length === TIMELINE_SIGNAL_PREFIX.length) {
      throw new Error(`native_signal_key_invalid: render timeline signal key ${JSON.stringify(key)} is not signal:<OpenDRIVE id>`);
    }
    const id = key.slice(TIMELINE_SIGNAL_PREFIX.length);
    const { lens, substituted } = signalLens(indications[key]!, t);
    if (substituted) evidence.substituted.add(indications[key]!);
    const guid = guids.get(id);
    if (!guid) {
      evidence.unbound.add(id);
      continue;
    }
    const previous = owner.get(guid);
    if (previous !== undefined) {
      if (out[guid] !== lens) {
        const ids = evidence.conflicts.get(guid) ?? new Set<string>();
        ids.add(previous).add(id);
        evidence.conflicts.set(guid, ids);
      }
      continue;
    }
    owner.set(guid, id);
    out[guid] = lens;
  }
  return out;
}

/** Manifest warnings for a lowering's signal binding. */
export function signalBindingWarnings(evidence: SignalBindingEvidence): { code: string; message: string }[] {
  const list = (items: readonly string[]) => (items.length > 12 ? `${items.slice(0, 12).join(', ')} and ${items.length - 12} more` : items.join(', '));
  const warnings: { code: string; message: string }[] = [];
  if (evidence.unbound.length > 0) {
    warnings.push({
      code: 'native_signal_unbound',
      message: `timeline signal(s) ${list(evidence.unbound)} have no rendered head (their OpenDRIVE <signal> names no vectorSignal asset); nothing shows their indication`,
    });
  }
  for (const [guid, ids] of evidence.conflicts) {
    warnings.push({
      code: 'native_signal_head_conflict',
      message: `signal head ${guid} is driven by timeline signals ${list([...ids])}, which disagree; it shows the lens of signal ${[...ids].sort()[0]}`,
    });
  }
  if (evidence.substituted.length > 0) {
    warnings.push({
      code: 'native_signal_lens_substituted',
      message: `indication(s) ${list(evidence.substituted)} are drawn on the round lens of their colour (the map's heads have no arrow or symbol lenses)`,
    });
  }
  return warnings;
}
