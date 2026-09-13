"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@simforge-oss/studio-ui/components/ui/tooltip";
import type { CandidateLocation } from "@simforge-oss/studio-shared";
import {
  humanizeTag,
  getAllCandidateTags,
  buildCompactEvidence,
  buildTooltipDetail,
  type ScenarioFamily,
} from "@/app/lib/scenario-intelligence-ui";

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
      className={stylex.props(styles.candidateCard, selected ? styles.candidateCardSelected : styles.candidateCardIdle).className}
    >
      {/* Row 1: Label + confidence */}
      <div className={stylex.props(styles.s_831).className}>
        <p className={stylex.props(styles.s_814).className}>{candidate.label}</p>
        <span
          className={stylex.props(
            styles.confidenceBadge,
            candidate.confidence >= 0.9
              ? styles.confidenceHigh
              : candidate.confidence >= 0.75
                ? styles.confidenceMedium
                : styles.confidenceLow,
          ).className}
        >
          {Math.round(candidate.confidence * 100)}%
        </span>
      </div>

      {/* Row 2: One-line explanation */}
      {explanation && (
        <p className={stylex.props(styles.s_458).className}>{explanation}</p>
      )}

      {/* Row 3: Family chip + tag chips */}
      {(family || visibleTags.length > 0) && (
        <div className={stylex.props(styles.s_459).className}>
          {family && (
            <span className={stylex.props(styles.s_460).className}>
              {family.name}
            </span>
          )}
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className={stylex.props(styles.s_461).className}
            >
              {humanizeTag(tag)}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className={stylex.props(styles.s_462).className}>
              +{overflowCount}
            </span>
          )}
        </div>
      )}

      {/* Row 4: Compact evidence */}
      {evidence && (
        <p className={stylex.props(styles.s_463).className}>{evidence}</p>
      )}
    </button>
    </TooltipTrigger>
    {tooltipText && (
      <TooltipContent side="bottom" xstyle={styles.s_984}>
        {tooltipText}
      </TooltipContent>
    )}
    </Tooltip>
    </TooltipProvider>
  );
}
