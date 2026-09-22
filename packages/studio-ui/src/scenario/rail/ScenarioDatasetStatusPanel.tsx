"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioDatasetStatusPanel.stylex";
import { useMemo } from "react";
import type {
  ScenarioDatasetReadinessDto,
  ScenarioDocumentSummaryDto,
} from "../../lib/scenario/contracts";
import { cn } from "../../lib/utils";
import { textLayout } from "../../stylex/recipes.stylex";

type ReadinessSummary = ScenarioDatasetReadinessDto["summary"];

function CoverageBar({
  label,
  covered,
  total,
}: {
  label: string;
  covered: number;
  total: number;
}) {
  const ratio = total > 0 ? Math.min(1, covered / total) : 0;
  return (
    <div>
      <div {...stylex.props(styles.divFlexMetaMicro)}>
        <span {...stylex.props(styles.span)}>{label}</span>
        <span {...stylex.props(styles.span2)}>
          {covered} / {total}
        </span>
      </div>
      <div
        {...stylex.props(styles.progressbar)}
        role="progressbar"
        aria-label={`${label} coverage`}
        aria-valuenow={covered}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div {...stylex.props(styles.div)} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * In-editor dataset status: coverage, and who has been working in this dataset.
 *
 * **Two v1 sections are deliberately absent.** v1's panel read `/api/datasets/[id]/activity` for a
 * per-contributor authored/rendered/simulated breakdown and `/render-gallery` for nine trailing render
 * thumbnails. Neither endpoint exists in v2, and inventing one for the gallery would fork the render
 * control plane. The contributor table here is derived from the loaded summaries' `createdByUserName` /
 * `updatedByUserName` instead, so it needs no new endpoint and cannot disagree with the list; the
 * render gallery belongs to the render tab.
 *
 * The counters come from `GET /datasets/[id]/readiness`, whose shape is `{summary, scenarios}` — the
 * same shape v1's `applyDatasetReadiness` consumed.
 */
export function ScenarioDatasetStatusPanel({
  datasetName,
  readiness,
  documents,
  className,
}: {
  datasetName: string | null;
  readiness: ReadinessSummary | null;
  documents: ScenarioDocumentSummaryDto[];
  className?: string;
}) {
  const contributors = useMemo(() => {
    const byName = new Map<string, { name: string; authored: number; edited: number }>();
    for (const document of documents) {
      const author = document.createdByUserName?.trim();
      if (author) {
        const entry = byName.get(author) ?? { name: author, authored: 0, edited: 0 };
        entry.authored += 1;
        byName.set(author, entry);
      }
      const editor = document.updatedByUserName?.trim();
      // Only count an edit when somebody other than the author made it; otherwise every document
      // would report one edit by its own author and the column would say nothing.
      if (editor && editor !== author) {
        const entry = byName.get(editor) ?? { name: editor, authored: 0, edited: 0 };
        entry.edited += 1;
        byName.set(editor, entry);
      }
    }
    return [...byName.values()].sort(
      (a, b) => b.authored + b.edited - (a.authored + a.edited) || a.name.localeCompare(b.name),
    );
  }, [documents]);

  const total = readiness?.total ?? documents.length;

  return (
    <div
      className={cn("space-y-4 border border-border bg-surface-raised p-3", className)}
      data-testid="scenario-dataset-status"
    >
      <div>
        <p {...stylex.props(styles.datasetStatus)}>
          Dataset status
        </p>
        <p {...stylex.props([textLayout.truncate, styles.pTruncateSmSemibold])}>{datasetName ?? "Dataset"}</p>
      </div>
      <div {...stylex.props(styles.div2)}>
        <CoverageBar label="Rendered" covered={readiness?.rendered ?? 0} total={total} />
        <CoverageBar label="Cosmos" covered={readiness?.cosmosed ?? 0} total={total} />
        <CoverageBar label="VLM" covered={readiness?.vlmed ?? 0} total={total} />
      </div>
      <div>
        <p {...stylex.props(styles.contributors)}>
          Contributors
        </p>
        {contributors.length === 0 ? (
          <p {...stylex.props(styles.noNamedContributorsYet)}>No named contributors yet.</p>
        ) : (
          <ul {...stylex.props(styles.ul)}>
            {contributors.slice(0, 8).map((contributor) => (
              <li
                key={contributor.name}
                {...stylex.props(styles.liFlexXs)}
              >
                <span {...stylex.props([textLayout.truncate, styles.spanTruncate])}>{contributor.name}</span>
                <span {...stylex.props(styles.spanMetaMicroUppercase)}>
                  {contributor.authored} authored
                  {contributor.edited > 0 ? ` · ${contributor.edited} edited` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
