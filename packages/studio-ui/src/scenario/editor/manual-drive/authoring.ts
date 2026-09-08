import {
  competingMotionInteractions,
  isMotionInteraction,
  manualDriveFor,
  manualDrivePlaceholder,
  type EditorDocument,
} from "@simforge-oss/editor";
import type { Interaction } from "@simforge-oss/scenario";

import { notifyScenario } from "../status";

/**
 * Why a new motion instruction cannot be added to this actor, or `null`.
 *
 * A manual drive owns the actor's motion for the whole clip. Rather than let a
 * speed or lane action land beside it and be rejected by validation later, the
 * menus explain the exclusivity at the point of adding.
 */
export function competingMotionRefusal(
  document: EditorDocument,
  actor: { readonly id: string; readonly label: string },
  candidate: Pick<Interaction, "verb">,
): string | null {
  if (!isMotionInteraction(candidate) || !manualDriveFor(document.data, actor.id)) return null;
  return `${actor.label} is driven manually for the whole clip. Delete its Manual drive, or record it again, before adding other motion.`;
}

/**
 * Give the actor a whole-clip Manual drive that holds its current pose until a
 * take is recorded. Any other motion the actor had is removed in the same undo
 * step, and the author is told what went.
 */
export function addManualDrive(
  document: EditorDocument,
  actor: { readonly id: string; readonly label: string },
): { readonly interactionId: string } | { readonly error: string } {
  const record = document.actor(actor.id);
  if (!record) return { error: "The actor has no resolved pose to record from." };
  if (record.static) return { error: "Static / parked actors cannot be driven. Turn off Static / parked first." };
  const existing = manualDriveFor(document.data, actor.id);
  if (existing) return { interactionId: existing.id };
  const removed = competingMotionInteractions(document.data.choreography.interactions, actor.id);
  const placeholder = manualDrivePlaceholder(record, document.data.choreography.clipSeconds);
  document.replaceActorMotion(placeholder);
  if (removed.length > 0) {
    notifyScenario({
      severity: "info",
      source: "authoring",
      message: `Manual drive now owns ${actor.label}'s motion`,
      detail: `Removed ${removed.map((interaction) => interaction.label ?? interaction.verb).join(", ")}. Undo restores them.`,
    });
  }
  return { interactionId: placeholder.id };
}

/** Distance along a recorded track and its peak speed, for the review and inspector. */
export function summarizeRecording(recording: {
  readonly samples: readonly { readonly x: number; readonly z: number; readonly speedMps: number }[];
}): { readonly distanceM: number; readonly maxSpeedKph: number } {
  let distanceM = 0;
  let maxSpeedMps = 0;
  for (let index = 0; index < recording.samples.length; index += 1) {
    const sample = recording.samples[index]!;
    maxSpeedMps = Math.max(maxSpeedMps, Math.abs(sample.speedMps));
    if (index === 0) continue;
    const previous = recording.samples[index - 1]!;
    distanceM += Math.hypot(sample.x - previous.x, sample.z - previous.z);
  }
  return { distanceM, maxSpeedKph: maxSpeedMps * 3.6 };
}
