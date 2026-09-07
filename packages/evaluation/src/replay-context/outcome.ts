/**
 * Episode outcome classification for replay-context scenes.
 *
 * An episode that left the validity envelope produced real numbers up to the breach and
 * nothing trustworthy after it. Both halves of that sentence matter, and the failure mode this
 * module exists to prevent is letting the first half quietly stand in for a complete result:
 * a truncated episode must never be counted as a success in a scored aggregate, and must never
 * be silently dropped either, because a scene that keeps truncating is itself the finding.
 *
 * So the contract is a partition, not a flag:
 *
 *   `aggregate`   complete episodes inside the envelope — the only ones a headline score,
 *                 a model comparison or a promotion decision may be computed from;
 *   `diagnostic`  truncated or invalid episodes — retained, reported, never averaged into the
 *                 headline, and never presented as a model's performance.
 *
 * `partitionOutcomes` is the single place that split is made, so an aggregator cannot forget
 * the rule by writing its own filter, and a report can always state how many episodes were
 * excluded and why.
 */

/** Why an episode stopped before its planned end. */
export type TruncationReason = 'envelope_exceeded' | 'invalid_scene' | 'runner_error';

export interface EpisodeOutcomeInput {
  readonly episodeId: string;
  /** True when the episode ran to its planned end. */
  readonly complete: boolean;
  /** Set when the episode stopped early. */
  readonly truncation?: TruncationReason;
  /** Which envelope limits were breached, when the reason is `envelope_exceeded`. */
  readonly breached?: readonly string[];
  /** Decision step the breach occurred at, for the report. */
  readonly atStep?: number;
}

export interface EpisodeOutcome {
  readonly episodeId: string;
  readonly status: 'complete' | 'truncated' | 'invalid';
  /**
   * May this episode contribute to a scored aggregate? False for anything truncated: the
   * metrics it produced describe a partial drive, and averaging them with complete episodes
   * silently rewards a scene for stopping early.
   */
  readonly aggregateEligible: boolean;
  /** True when the episode's metrics may only be shown as separate partial diagnostics. */
  readonly diagnosticsOnly: boolean;
  /** Never true for a truncated episode, whatever the runner reported. */
  readonly succeeded: boolean;
  /** Human-readable explanation, suitable for a report row. */
  readonly reason: string;
}

const REASON_TEXT: Record<TruncationReason, string> = {
  envelope_exceeded:
    'the ego left the measured validity envelope; renders beyond it are extrapolation and the replayed actors '
    + 'no longer correspond to the drive being simulated',
  invalid_scene: 'the scene was not qualified for closed-loop execution',
  runner_error: 'the episode ended on a runner or infrastructure error, not on a driving outcome',
};

/**
 * Classify one episode.
 *
 * A truncated episode is never `succeeded`, regardless of how far it got or what score the
 * partial trace would compute to. That is the invariant the rest of the pipeline relies on:
 * "it drove well for eight seconds before the world ran out" is a statement about the scene,
 * not a model result.
 */
export function classifyEpisodeOutcome(input: EpisodeOutcomeInput): EpisodeOutcome {
  if (input.complete && input.truncation === undefined) {
    return {
      episodeId: input.episodeId,
      status: 'complete',
      aggregateEligible: true,
      diagnosticsOnly: false,
      succeeded: true,
      reason: 'completed inside the validity envelope',
    };
  }
  const truncation = input.truncation ?? 'runner_error';
  const where = input.atStep === undefined ? '' : ` at step ${input.atStep}`;
  const limits = input.breached === undefined || input.breached.length === 0
    ? ''
    : ` (breached: ${input.breached.join(', ')})`;
  return {
    episodeId: input.episodeId,
    status: truncation === 'invalid_scene' ? 'invalid' : 'truncated',
    aggregateEligible: false,
    diagnosticsOnly: true,
    succeeded: false,
    reason: `${REASON_TEXT[truncation]}${where}${limits}`,
  };
}

export interface OutcomePartition {
  /** Episodes a headline score may be computed from. */
  readonly aggregate: readonly EpisodeOutcome[];
  /** Episodes retained as partial evidence only. */
  readonly diagnostic: readonly EpisodeOutcome[];
  /** Counts for the report header, so exclusions are always visible. */
  readonly counts: {
    readonly total: number;
    readonly complete: number;
    readonly truncated: number;
    readonly invalid: number;
  };
}

/**
 * Split a run's episodes into what may be aggregated and what may only be reported.
 *
 * Every consumer that computes a headline number should go through this rather than filtering
 * itself, so the exclusion rule has one definition and every report can say how many episodes
 * were held out.
 */
export function partitionOutcomes(outcomes: readonly EpisodeOutcome[]): OutcomePartition {
  const aggregate = outcomes.filter((outcome) => outcome.aggregateEligible);
  const diagnostic = outcomes.filter((outcome) => !outcome.aggregateEligible);
  return {
    aggregate,
    diagnostic,
    counts: {
      total: outcomes.length,
      complete: outcomes.filter((outcome) => outcome.status === 'complete').length,
      truncated: outcomes.filter((outcome) => outcome.status === 'truncated').length,
      invalid: outcomes.filter((outcome) => outcome.status === 'invalid').length,
    },
  };
}
