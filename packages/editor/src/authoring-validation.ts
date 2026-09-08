import type { Interaction } from '@simforge-oss/scenario';
import { isManualDrive } from './manual-drive';

export const SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES = [
  'traffic_control_route_unbound',
  'timed_route_turn_unreachable',
  'target_timing_infeasible',
] as const;

type SimpleModeSuppressedEngineIssueCode =
  (typeof SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES)[number];

const SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUES: Readonly<Record<
  SimpleModeSuppressedEngineIssueCode,
  true
>> = {
  traffic_control_route_unbound: true,
  timed_route_turn_unreachable: true,
  target_timing_infeasible: true,
};

/** Whether Simple mode should hide an engine-domain validation finding. */
export function isSimpleModeEngineIssueSuppressed(code: string | null | undefined): boolean {
  return code != null
    && SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUES[
      code as SimpleModeSuppressedEngineIssueCode
    ] === true;
}

export type EditorAuthoringValidationIssue = {
  readonly id: string;
  readonly severity: 'error' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly solution?: string;
};

/**
 * Find custom timed routes that cannot be previewed because no points have
 * been authored yet.
 */
export function emptyTimedRouteIssues(
  interactions: readonly Interaction[],
  actorNames?: Readonly<Record<string, string>>,
): EditorAuthoringValidationIssue[] {
  const issues: EditorAuthoringValidationIssue[] = [];
  for (const interaction of interactions) {
    if (
      interaction.verb !== 'route'
      || interaction.target.mode !== 'customTimedRoute'
      || (Array.isArray(interaction.target.points) && interaction.target.points.length > 0)
    ) {
      continue;
    }
    const actorName = actorNames?.[interaction.actor] ?? interaction.actor;
    issues.push({
      id: `timed-route-empty:${interaction.id}`,
      severity: 'error',
      title: 'Custom timed route has no points',
      detail: `${actorName}'s custom timed route needs at least one point before it can be previewed.`,
      solution: 'Open the route, add its first point on the map, then run the preview again.',
    });
  }
  return issues;
}

/**
 * Find manual drives whose take was recorded against a different clip length.
 * The scenario cannot honestly replay a take over a clip it does not cover.
 */
export function manualDriveIssues(
  interactions: readonly Interaction[],
  clipSeconds: number,
  actorNames?: Readonly<Record<string, string>>,
): EditorAuthoringValidationIssue[] {
  const issues: EditorAuthoringValidationIssue[] = [];
  for (const interaction of interactions) {
    if (!isManualDrive(interaction) || Math.abs(interaction.target.recording.clipSeconds - clipSeconds) <= 1e-6) continue;
    const actorName = actorNames?.[interaction.actor] ?? interaction.actor;
    issues.push({
      id: `manual-drive-clip-mismatch:${interaction.id}`,
      severity: 'error',
      title: 'Manual drive recorded for a different clip length',
      detail: `${actorName}'s drive was recorded for ${interaction.target.recording.clipSeconds}s but the clip is now ${clipSeconds}s.`,
      solution: 'Record the drive again, or restore the clip length it was recorded for.',
    });
  }
  return issues;
}
