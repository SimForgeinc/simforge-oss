"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CandidateLocationsSection.stylex";

import { ChevronRight, Loader2 } from "lucide-react";
import type { CandidateLocation } from "@simforge-oss/studio-shared";
import { CandidateLocationCard } from "./CandidateLocationCard";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/** Props for the CandidateLocationsSection component. */
type CandidateLocationsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
};

/** Render selectable candidate simulation locations for a map asset. */
export function CandidateLocationsSection({
  open,
  onToggleOpen,
  candidateLocations,
  candidateLocationsLoading,
  selectedCandidateLocationId,
  onSelectCandidateLocationId,
}: CandidateLocationsSectionProps) {
  return (
    <section>
      <div {...stylex.props(styles.sectionHeaderContainer)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props([motionRecipe.colors, styles.candidateLocationsToggle])}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
          />
          Candidate Locations
          {candidateLocations.length > 0 && (
            <span {...stylex.props(styles.candidateCountBadge)}>
              {candidateLocations.length}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div {...stylex.props(styles.candidateLocationsContent)}>
          {candidateLocationsLoading ? (
            <p {...stylex.props(styles.loadingMessage)}>
              <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingSpinner])} /> Loading…
            </p>
          ) : candidateLocations.length === 0 ? (
            <p {...stylex.props(styles.emptyStateMessage)}>
              No candidate locations computed yet.
            </p>
          ) : (
            <ul {...stylex.props(styles.candidateLocationsList)}>
              {candidateLocations.map((candidate) => (
                <li key={candidate.id}>
                  <CandidateLocationCard
                    candidate={candidate}
                    selected={selectedCandidateLocationId === candidate.id}
                    onSelect={(id) => onSelectCandidateLocationId?.(id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
