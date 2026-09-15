"use client";

/**
 * One cloud run's result on the desktop — the same component the web portal
 * renders, so a run submitted in the browser and opened here shows identical
 * metrics, provenance and refusals.
 *
 * A stage pane: the workspace's rail already says which run this is, so the
 * pane carries no page header and no way back.
 */

import * as stylex from "@stylexjs/stylex";
import { JobDetail } from "@simforge-oss/studio-ui/evaluation";
import { useEvaluationGateway } from "@/app/lib/host/evaluation";
import { styles } from "../route-residuals.stylex";

export function RunDetailClient({ jobId }: { jobId: string }) {
  // Reads are workspace-resolved from the connected session; only writes need
  // an explicit workspace, and this screen performs none.
  const gateway = useEvaluationGateway(null);

  return (
    <div {...stylex.props(styles.content)}>
      <JobDetail gateway={gateway} jobId={jobId} />
    </div>
  );
}
