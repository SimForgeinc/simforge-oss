"use client";

/**
 * The runs stage with nothing selected: start a prediction.
 *
 * An empty stage would be a dead half of the screen, and "start a run" is the
 * thing a person comes to this page to do. So the launcher itself is the
 * landing state, with the last few finished runs under it — recognising one by
 * its model and time is faster than finding it again in the rail.
 */

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { ComputeJob, EvaluationGateway } from "@simforge-oss/evaluation/client";
import { EvaluationLauncher, type LocalRunLauncher } from "../components/EvaluationLauncher";
import type { HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { jobStatusPresentation } from "../presentation";
import { styles } from "./LaunchStage.stylex";
import { typography } from "../../stylex/recipes.stylex";

export function LaunchStage({
  gateway,
  host,
  runtime,
  onSubmitted,
  onRunLocally,
  recent,
  onSelectRun,
  notice,
}: {
  gateway: EvaluationGateway;
  host: HostExecutionSnapshot;
  runtime: ModelRuntimeSnapshot | null;
  onSubmitted: (job: ComputeJob) => void;
  onRunLocally?: LocalRunLauncher;
  /** Finished runs, newest first; the stage shows the first handful. */
  recent: readonly ComputeJob[];
  onSelectRun: (jobId: string) => void;
  notice?: ReactNode;
}) {
  const filmstrip = recent.slice(0, 6);
  return (
    <div {...stylex.props(styles.root)} data-testid="evaluation-launch-stage">
      <div {...stylex.props(styles.intro)}>
        <h1 {...stylex.props(styles.title)}>Predict from uploaded video</h1>
        <p {...stylex.props(styles.lede)}>
          Upload one driving video or synchronized camera views, then run AlpaMayo 1.5 or 2 Super.
          The durable result includes a playable trajectory and reasoning overlay plus timestamped
          model output. This exploratory workflow is approximate and unscored.
        </p>
        {notice}
      </div>

      <EvaluationLauncher
        variant="stage"
        gateway={gateway}
        host={host}
        runtime={runtime}
        onSubmitted={onSubmitted}
        onRunLocally={onRunLocally}
      />

      {filmstrip.length > 0 ? (
        <div {...stylex.props(styles.recent)}>
          <h2 {...stylex.props([typography.eyebrow, styles.recentLabel])}>Recent results</h2>
          <ul {...stylex.props(styles.filmstrip)}>
            {filmstrip.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => onSelectRun(job.id)}
                  {...stylex.props(styles.clip)}
                  data-testid={`recent-run-${job.id}`}
                >
                  <span {...stylex.props(styles.clipTitle)}>{job.model.family}</span>
                  <span {...stylex.props(styles.clipMeta)}>
                    {jobStatusPresentation(job.status).label} · {job.model.quant}
                  </span>
                  <span {...stylex.props(styles.clipMeta)}>
                    {new Date(job.finishedAt ?? job.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
