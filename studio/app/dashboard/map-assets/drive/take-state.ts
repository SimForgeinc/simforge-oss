import {
  competingMotionInteractions,
  isMotionInteraction,
  manualDriveFor,
  recordedManualDrive,
} from "@simforge-oss/editor";
import type { Interaction, ManualDriveRecording, ScenarioTemplateV2 } from "@simforge-oss/scenario";

/**
 * The lifecycle of one Driver in the Loop take.
 *
 * Nothing here records or saves on its own. A take starts only from an
 * explicit user action (the start button, or a deliberate pedal or wheel
 * input) and only once the map is on screen and the driven car is in the
 * world; a finished take waits for "Keep take" or "Discard"; leaving the page
 * from any state writes nothing. The one path into the scenario is `keep`.
 *
 * - `loading`   the map or the world is not ready; the car cannot be driven yet
 * - `ready`     armed: the world holds at t = 0 until the driver starts
 * - `recording` the clip is being driven
 * - `review`    the clip is recorded and held in memory, awaiting keep/discard
 * - `saving`    the driver kept it; the scenario is being written
 * - `saved`     written
 * - `failed`    recording or saving failed. A failed save keeps its recording,
 *               so the take can be kept again or discarded; nothing is lost.
 */
export type TakeState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "recording" }
  | { readonly kind: "review"; readonly recording: ManualDriveRecording }
  | { readonly kind: "saving"; readonly recording: ManualDriveRecording }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly message: string; readonly recording: ManualDriveRecording | null };

export type TakeAction =
  /** The map is loaded and revealed and the driven car exists in the world. */
  | { readonly type: "interactive" }
  /** The map or the world went away (reload, rebuild) before a take started. */
  | { readonly type: "not-interactive" }
  /** The driver asked to record: the start button, or a deliberate control input. */
  | { readonly type: "start" }
  | { readonly type: "recorded"; readonly recording: ManualDriveRecording }
  | { readonly type: "record-failed"; readonly message: string }
  /** The driver confirmed the take goes into the scenario. */
  | { readonly type: "keep" }
  /** The driver threw the take away. */
  | { readonly type: "discard" }
  | { readonly type: "saved" }
  | { readonly type: "save-failed"; readonly message: string };

export const INITIAL_TAKE_STATE: TakeState = { kind: "loading" };

/**
 * The take reducer. An action that does not apply to the current state leaves
 * it unchanged (the same object): a double-clicked Keep, a stray pedal press
 * during review, or a worker event for a take that is no longer live must not
 * move the take anywhere.
 */
export function takeReducer(state: TakeState, action: TakeAction): TakeState {
  switch (action.type) {
    case "interactive":
      return state.kind === "loading" ? { kind: "ready" } : state;
    case "not-interactive":
      return state.kind === "ready" ? { kind: "loading" } : state;
    case "start":
      if (state.kind === "ready") return { kind: "recording" };
      // "Drive it again" after a recording that failed. A failed SAVE still
      // holds a recording and is resolved with keep or discard, never by
      // silently driving over it.
      if (state.kind === "failed" && state.recording === null) return { kind: "recording" };
      return state;
    case "recorded":
      return state.kind === "recording" ? { kind: "review", recording: action.recording } : state;
    case "record-failed":
      return state.kind === "recording" ? { kind: "failed", message: action.message, recording: null } : state;
    case "keep":
      if (state.kind === "review") return { kind: "saving", recording: state.recording };
      if (state.kind === "failed" && state.recording !== null) return { kind: "saving", recording: state.recording };
      return state;
    case "discard":
      if (state.kind === "review" || state.kind === "failed") return { kind: "ready" };
      return state;
    case "saved":
      return state.kind === "saving" ? { kind: "saved" } : state;
    case "save-failed":
      return state.kind === "saving" ? { kind: "failed", message: action.message, recording: state.recording } : state;
  }
}

/**
 * How far a pedal or the wheel has to move before it counts as the driver
 * starting a take. Half travel: a resting gamepad trigger or a drifting stick
 * reports small values without anyone touching it, and those must never start
 * a recording.
 */
export const DELIBERATE_INPUT_THRESHOLD = 0.5;

export function isDeliberateControl(command: {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
}): boolean {
  return command.throttle >= DELIBERATE_INPUT_THRESHOLD
    || command.brake >= DELIBERATE_INPUT_THRESHOLD
    || Math.abs(command.steer) >= DELIBERATE_INPUT_THRESHOLD;
}

/**
 * The motion a kept take would replace on the driven actor: every motion
 * instruction it has, an earlier recorded take included.
 */
export function motionReplacedByTake(template: ScenarioTemplateV2, roleId: string): Interaction[] {
  return template.choreography.interactions.filter(
    (interaction) => interaction.actor === roleId && isMotionInteraction(interaction),
  );
}

/**
 * The template with the recorded take as the actor's motion, computed without
 * touching the live document: every other motion instruction on the actor is
 * displaced, exactly as `EditorDocument.replaceActorMotion` does, and an
 * earlier take keeps its id and label.
 */
export function templateWithTake(
  template: ScenarioTemplateV2,
  roleId: string,
  recording: ManualDriveRecording,
): ScenarioTemplateV2 {
  const take = recordedManualDrive(roleId, recording, manualDriveFor(template, roleId));
  const displaced = new Set(competingMotionInteractions(template.choreography.interactions, roleId, take.id).map((interaction) => interaction.id));
  const kept = template.choreography.interactions.filter((interaction) => !displaced.has(interaction.id));
  const index = kept.findIndex((interaction) => interaction.id === take.id);
  const interactions = index === -1 ? [...kept, take] : kept.map((interaction, i) => (i === index ? take : interaction));
  return { ...template, choreography: { ...template.choreography, interactions } };
}
