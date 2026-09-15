/**
 * Manual drive: one recorded take owns an actor's motion for the whole clip.
 *
 * The canonical schema (`@simforge-oss/scenario`) owns the recording shape and
 * its validity rules; this module owns only how the editor authors around it —
 * the interaction a saved take becomes, and the exclusivity rule that keeps a
 * second motion instruction off a driven actor. Takes are produced by the
 * Driver in the Loop drive, which records against a variation created for it,
 * so there is no guard here: no one else is editing that document.
 */

import type {
  Interaction,
  ManualDriveRecording,
  ScenarioTemplateV2,
} from '@simforge-oss/scenario';

/** The interaction's label. A route variant, deliberately not an eighth verb. */
export const MANUAL_DRIVE_LABEL = 'Manual drive';

/** A route interaction whose motion is a recorded manual take. */
export type ManualDriveInteraction = Extract<Interaction, { verb: 'route' }> & {
  readonly target: { readonly mode: 'manualDrive'; readonly recording: ManualDriveRecording };
};

/** Verbs that would compete with a manual take for the actor's motion. */
const MOTION_VERBS: Partial<Record<Interaction['verb'], true>> = {
  speed: true,
  gap: true,
  changeLane: true,
  laneOffset: true,
  route: true,
};

export function isManualDrive(interaction: Interaction): interaction is ManualDriveInteraction {
  return interaction.verb === 'route' && interaction.target.mode === 'manualDrive';
}

/** Whether adding this interaction to a manually driven actor would contest its motion. */
export function isMotionInteraction(interaction: Pick<Interaction, 'verb'>): boolean {
  return MOTION_VERBS[interaction.verb] === true;
}

/** Stable id: an actor owns at most one manual drive. */
export function manualDriveInteractionId(actorId: string): string {
  return `manual_drive_${actorId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** The actor's manual drive, if it has one. */
export function manualDriveFor(
  template: Pick<ScenarioTemplateV2, 'choreography'>,
  actorId: string,
): ManualDriveInteraction | undefined {
  return template.choreography.interactions.find(
    (interaction): interaction is ManualDriveInteraction => interaction.actor === actorId && isManualDrive(interaction),
  );
}

/** Every motion instruction on the actor other than `exceptId`. */
export function competingMotionInteractions(
  interactions: readonly Interaction[],
  actorId: string,
  exceptId?: string,
): Interaction[] {
  return interactions.filter(
    (interaction) => interaction.actor === actorId && interaction.id !== exceptId && isMotionInteraction(interaction),
  );
}

/** The interaction a saved take becomes: whole-clip, stable id, prior label kept. */
export function recordedManualDrive(
  actorId: string,
  recording: ManualDriveRecording,
  existing?: ManualDriveInteraction,
): ManualDriveInteraction {
  return {
    ...existing,
    id: existing?.id ?? manualDriveInteractionId(actorId),
    actor: actorId,
    label: existing?.label ?? MANUAL_DRIVE_LABEL,
    trigger: { kind: 'at', t: 0 },
    until: { kind: 'at', t: recording.clipSeconds },
    verb: 'route',
    target: { mode: 'manualDrive', recording },
  };
}

