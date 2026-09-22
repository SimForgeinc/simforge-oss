"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioRating.stylex";
import { Star } from "lucide-react";
import type { ScenarioRatingAggregateDto } from "../../lib/scenario/contracts";
import { Badge } from "../../components/ui/badge";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { cn } from "../../lib/utils";
import { list } from "../scenario-controls.stylex";
import { typography } from "../../stylex/recipes.stylex";

/**
 * The 1–5 star widget, ported one-to-one from v1's `ScenarioRating`.
 *
 * `reviewState` carries v1's exact semantics from `document_review_state_v`: no ratings is pending,
 * any single score below four rejects, otherwise accepted (§6.2).
 */
export function ScenarioRating({
  aggregate,
  loading = false,
  saving = false,
  error = null,
  documentName,
  onSetRating,
}: {
  aggregate?: ScenarioRatingAggregateDto;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  documentName: string;
  onSetRating: (rating: number) => void;
}) {
  const rating = aggregate?.viewerScore ?? 0;
  return (
    <div {...stylex.props(styles.divFlex)}>
      <div
        {...stylex.props(styles.ratingFor)}
        role="radiogroup"
        aria-label={`Rating for ${documentName}`}
        data-scenario-rating={rating}
      >
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = rating >= star;
          return (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={rating === star}
              aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
              title={`${star} ${star === 1 ? "star" : "stars"}`}
              disabled={loading || saving}
              className={cn(
                "flex size-4 items-center justify-center transition-colors hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50",
                filled ? "text-primary" : "text-foreground/25",
              )}
              onClick={() => onSetRating(star)}
            >
              <Star
                className={cn("size-3.5", filled ? "fill-current" : "fill-none")}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      <span
        {...stylex.props([typography.eyebrow, styles.spanMetaMicroUppercase])}
        data-scenario-rating-aggregate=""
      >
        {saving || loading ? (
          <CloudActivityIndicator label={saving ? "Saving…" : "Loading…"} />
        ) : error
              ? "Rating unavailable"
              : aggregate && aggregate.ratingCount > 0
                ? `${aggregate.averageScore.toFixed(1)} avg · ${aggregate.ratingCount}`
                : "No ratings"}
      </span>
      {aggregate?.reviewState === "rejected" ? (
        <Badge
          variant="outline"
          xstyle={[typography.tag, list.rejectedBadge]}
        >
          Rejected (&lt;4)
        </Badge>
      ) : null}
    </div>
  );
}
