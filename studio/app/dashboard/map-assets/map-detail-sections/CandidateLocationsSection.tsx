"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Loader2 } from "lucide-react";
import type { CandidateLocation } from "@simforge-oss/studio-shared";
import { CandidateLocationCard } from "./CandidateLocationCard";

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
      <div className={stylex.props(styles.s_961).className}>
        <button
          type="button"
          onClick={onToggleOpen}
          className={stylex.props(styles.s_962).className}
          aria-expanded={open}
        >
          <ChevronRight
            className={stylex.props(styles.chevron, open && styles.rotate90).className}
          />
          Candidate Locations
          {candidateLocations.length > 0 && (
            <span className={stylex.props(styles.s_965).className}>
              {candidateLocations.length}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div className={stylex.props(styles.s_968).className}>
          {candidateLocationsLoading ? (
            <p className={stylex.props(styles.s_971).className}>
              <Loader2 className={stylex.props(styles.s_972).className} /> Loading…
            </p>
          ) : candidateLocations.length === 0 ? (
            <p className={stylex.props(styles.s_973).className}>
              No candidate locations computed yet.
            </p>
          ) : (
            <ul className={stylex.props(styles.s_986).className}>
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
