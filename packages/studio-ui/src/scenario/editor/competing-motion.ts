import { isMotionInteraction, manualDriveFor, type EditorDocument } from "@simforge-oss/editor";
import type { Interaction } from "@simforge-oss/scenario";

/**
 * Why a new motion instruction cannot be added to this actor, or `null`.
 *
 * A recorded drive owns the actor's motion for the whole clip. Rather than let a
 * speed or lane action land beside it and be rejected by validation later, the
 * menus explain the exclusivity at the point of adding.
 */
export function competingMotionRefusal(
  document: EditorDocument,
  actor: { readonly id: string; readonly label: string },
  candidate: Pick<Interaction, "verb">,
): string | null {
  if (!isMotionInteraction(candidate) || !document.data?.choreography || !manualDriveFor(document.data, actor.id)) return null;
  return `${actor.label} is driven by a recorded clip for the whole scenario. Delete its Manual drive, or drive it again, before adding other motion.`;
}
