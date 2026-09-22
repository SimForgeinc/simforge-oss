"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CandidateLocationCard.stylex";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@simforge-oss/studio-ui/components/ui/tooltip";
import type { CandidateLocation } from "@simforge-oss/studio-shared";
import {
  humanizeTag,
  getAllCandidateTags,
  buildCompactEvidence,
  buildTooltipDetail,
  type ScenarioFamily,
} from "@/app/lib/scenario-intelligence-ui";
import { hairline, motionRecipe, textLayout } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

const MAX_VISIBLE_TAGS = 3;

interface CandidateLocationCardProps {
  candidate: CandidateLocation;
  selected: boolean;
  onSelect: (id: string | null) => void;
  family?: ScenarioFamily;
  compact?: boolean;
}

/** Selectable candidate location card with label, confidence, tags, and evidence. */
export function CandidateLocationCard({
  candidate,
  selected,
  onSelect,
  family,
  compact: _compact = false,
}: CandidateLocationCardProps) {
  const allTags = getAllCandidateTags(candidate);
  const visibleTags = allTags.slice(0, MAX_VISIBLE_TAGS);
  const overflowCount = allTags.length - MAX_VISIBLE_TAGS;
  const evidence = buildCompactEvidence(candidate);
  const tooltipText = buildTooltipDetail(candidate);
  const explanation = candidate.evidence[0]?.explanation ?? "";

  return (
    <TooltipProvider delayDuration={300}>
    <Tooltip>
    <TooltipTrigger asChild>
    <button
      type="button"
      onClick={() => onSelect(selected ? null : candidate.id)}
      {...stylex.props([motionRecipe.colors, styles.candidateCard], selected ? styles.candidateCardSelected : styles.candidateCardIdle)}
    >
      {/* Row 1: Label + confidence */}
      <div {...stylex.props(styles.candidateHeader)}>
        <p {...stylex.props(styles.candidateLabel)}>{candidate.label}</p>
        <span
          {...stylex.props(
            styles.confidenceBadge,
            candidate.confidence >= 0.9
              ? styles.confidenceHigh
              : candidate.confidence >= 0.75
                ? styles.confidenceMedium
                : [hairline.all, styles.confidenceLow],
          )}
        >
          {Math.round(candidate.confidence * 100)}%
        </span>
      </div>

      {/* Row 2: One-line explanation */}
      {explanation && (
        <p {...stylex.props([textLayout.truncate, styles.candidateExplanation])}>{explanation}</p>
      )}

      {/* Row 3: Family chip + tag chips */}
      {(family || visibleTags.length > 0) && (
        <div {...stylex.props(styles.candidateTagsRow)}>
          {family && (
            <span {...stylex.props([hairline.all, styles.familyChip])}>
              {family.name}
            </span>
          )}
          {visibleTags.map((tag) => (
            <span
              key={tag}
              {...stylex.props([hairline.all, styles.tagChip])}
            >
              {humanizeTag(tag)}
            </span>
          ))}
          {overflowCount > 0 && (
            <span {...stylex.props(styles.tagOverflowChip)}>
              +{overflowCount}
            </span>
          )}
        </div>
      )}

      {/* Row 4: Compact evidence */}
      {evidence && (
        <p {...stylex.props(styles.compactEvidence)}>{evidence}</p>
      )}
    </button>
    </TooltipTrigger>
    {tooltipText && (
      <TooltipContent side="bottom" xstyle={styles.tooltipContent}>
        {tooltipText}
      </TooltipContent>
    )}
    </Tooltip>
    </TooltipProvider>
  );
}
