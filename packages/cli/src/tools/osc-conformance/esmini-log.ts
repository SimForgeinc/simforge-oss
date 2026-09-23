/**
 * esmini's text log records every StoryboardElement state transition:
 *
 * ```
 * [1.000] [info] event_brake standbyState -> startTransition -> runningState
 * ```
 *
 * The CSV logger has no lifecycle columns, so this is the only observable for
 * "when did the event start / end" on the esmini side.
 */

export type OscState = 'initState' | 'standbyState' | 'runningState' | 'completeState';

export interface StoryboardTransition {
  readonly t: number;
  readonly element: string;
  readonly from: OscState;
  readonly transition: string;
  readonly to: OscState;
}

const LINE = /^\[(-?\d+(?:\.\d+)?)\]\s+\[\w+\]\s+(.+?)\s+(initState|standbyState|runningState|completeState)\s+->\s+(\w+)\s+->\s+(initState|standbyState|runningState|completeState)\s*$/;

export function parseEsminiLog(text: string): StoryboardTransition[] {
  const transitions: StoryboardTransition[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    transitions.push({
      t: Number(match[1]),
      element: match[2]!,
      from: match[3] as OscState,
      transition: match[4]!,
      to: match[5] as OscState,
    });
  }
  return transitions;
}

/** Times an element entered `runningState` (one entry per execution). */
export function startTimes(transitions: readonly StoryboardTransition[], element: string): number[] {
  return transitions
    .filter((entry) => entry.element === element && entry.to === 'runningState' && entry.transition === 'startTransition')
    .map((entry) => entry.t);
}

/** Times an element left `runningState`, with the transition that ended it. */
export function endTimes(
  transitions: readonly StoryboardTransition[],
  element: string,
): { readonly t: number; readonly transition: string; readonly to: OscState }[] {
  return transitions
    .filter((entry) => entry.element === element && entry.from === 'runningState')
    .map((entry) => ({ t: entry.t, transition: entry.transition, to: entry.to }));
}

/** esmini warnings/errors worth surfacing in a conformance report. */
export function esminiDiagnostics(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /\[(warn|error)\]/.test(line))
    .filter((line) => !/3D model .* not located/.test(line))
    .map((line) => line.trim());
}
