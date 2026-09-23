import type { EvaluationStripLink } from "@simforge-oss/studio-ui/evaluation";

/**
 * Places a host adds to the Evaluation workspace's section strip, below Runs,
 * Campaigns and Models. A local installation adds none; a hosted deployment
 * replaces this module (the same seam as `host/kind.ts`) to link its own
 * evaluation pages, such as an archive of finished model comparisons.
 */
export const EVALUATION_HOST_LINKS: readonly EvaluationStripLink[] = [];
