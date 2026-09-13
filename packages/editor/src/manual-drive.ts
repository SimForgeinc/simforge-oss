/**
 * Manual drive: one recorded take owns an actor's motion for the whole clip.
 *
 * The canonical schema (`@simforge-oss/scenario`) owns the recording shape and
 * its validity rules; this module owns only how the editor authors around it:
 * the guard a recorder must echo back before its take may enter the document,
 * and the exclusivity rule that keeps a second motion instruction off a driven
 * actor. Nothing here ever fabricates a recording: until a take is reviewed
 * and saved, the document holds exactly the motion it had before.
 */

import { contentHash } from '@simforge-oss/engine';
import {
  validateManualDriveRecording,
  type Interaction,
  type ManualDriveRecording,
  type ScenarioTemplateV2,
} from '@simforge-oss/scenario';
import type { ActorRecord } from './document';

/** The palette label. A route variant, deliberately not an eighth verb. */
export const MANUAL_DRIVE_LABEL = 'Manual drive';

/** Quick-action id shared by the timeline menu and the sidebar palette. */
export const MANUAL_DRIVE_ACTION_ID = 'manual_drive';

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

/**
 * What a take was recorded against. Issued when the recorder opens and echoed
 * back unchanged with the take; the editor refuses any take whose guard no
 * longer describes the open document.
 */
export interface ManualDriveTakeGuard {
  readonly documentId: string;
  readonly mapVersionId: string;
  readonly actorRoleId: string;
  readonly interactionId: string;
  readonly clipSeconds: number;
  /** `contentHash` of the whole template at open time. */
  readonly contentHash: string;
}

export function manualDriveTakeGuard(input: {
  readonly documentId: string;
  readonly mapVersionId: string;
  readonly actorRoleId: string;
  readonly template: ScenarioTemplateV2;
}): ManualDriveTakeGuard {
  return {
    documentId: input.documentId,
    mapVersionId: input.mapVersionId,
    actorRoleId: input.actorRoleId,
    interactionId: manualDriveFor(input.template, input.actorRoleId)?.id ?? manualDriveInteractionId(input.actorRoleId),
    clipSeconds: input.template.choreography.clipSeconds,
    contentHash: contentHash(input.template),
  };
}

/** Opaque transport form of a guard. Recorders echo this string; only the editor reads it. */
export function encodeManualDriveTakeGuard(guard: ManualDriveTakeGuard): string {
  return JSON.stringify(guard);
}

export function decodeManualDriveTakeGuard(revision: string): ManualDriveTakeGuard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(revision);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.documentId !== 'string'
    || typeof value.mapVersionId !== 'string'
    || typeof value.actorRoleId !== 'string'
    || typeof value.interactionId !== 'string'
    || typeof value.clipSeconds !== 'number'
    || typeof value.contentHash !== 'string'
  ) return null;
  return {
    documentId: value.documentId,
    mapVersionId: value.mapVersionId,
    actorRoleId: value.actorRoleId,
    interactionId: value.interactionId,
    clipSeconds: value.clipSeconds,
    contentHash: value.contentHash,
  };
}

export type ManualDriveTakeCheck =
  | { readonly ok: true; readonly interaction: ManualDriveInteraction }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether a completed take may enter the open document, as the actor's
 * first Manual drive or as the replacement of its previous one. Every refusal
 * leaves the document untouched; the caller reports `reason` and keeps
 * whatever motion the actor already had.
 */
export function checkManualDriveTake(input: {
  readonly template: ScenarioTemplateV2;
  readonly documentId: string | null;
  readonly mapVersionId: string;
  readonly actor: Pick<ActorRecord, 'id' | 'kind' | 'static'> | undefined;
  readonly guard: ManualDriveTakeGuard;
  readonly recording: ManualDriveRecording;
}): ManualDriveTakeCheck {
  const { guard, template } = input;
  if (input.documentId !== guard.documentId) {
    return { ok: false, reason: 'This take was recorded for a different scenario document.' };
  }
  if (input.mapVersionId !== guard.mapVersionId) {
    return { ok: false, reason: 'This take was recorded on a different map version.' };
  }
  const existing = template.choreography.interactions.find((interaction) => interaction.id === guard.interactionId);
  if (existing && (!isManualDrive(existing) || existing.actor !== guard.actorRoleId)) {
    return { ok: false, reason: 'The Manual drive this take belongs to was replaced by a different action.' };
  }
  if (!input.actor || input.actor.id !== guard.actorRoleId) {
    return { ok: false, reason: 'The driven actor was removed from the scenario while recording.' };
  }
  if (input.actor.static) {
    return { ok: false, reason: 'The driven actor is now static / parked and cannot follow a recording.' };
  }
  if (Math.abs(template.choreography.clipSeconds - guard.clipSeconds) > 1e-6) {
    return { ok: false, reason: 'The clip length changed while recording. Record the drive again.' };
  }
  if (contentHash(template) !== guard.contentHash) {
    return { ok: false, reason: 'The scenario was edited while recording, so the take no longer matches it. Record the drive again.' };
  }
  const validity = validateManualDriveRecording(input.recording, template.choreography.clipSeconds);
  if (!validity.ok) {
    return { ok: false, reason: `The recording is not usable (${validity.path}): ${validity.message}` };
  }
  return { ok: true, interaction: recordedManualDrive(guard.actorRoleId, input.recording, existing) };
}
