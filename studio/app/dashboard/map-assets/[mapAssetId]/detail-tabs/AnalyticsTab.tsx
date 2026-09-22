"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./AnalyticsTab.stylex";

import { Loader2 } from "lucide-react";
import type {
  CandidateLocation,
  MapAsset,
  MapAssetEnrichmentSnapshot,
} from "@simforge-oss/studio-shared";
import type { ThreeDStats as ThreeDStatsResponse } from "@/app/lib/3d-manifest-stats";
import type { ViewMode } from "../MapDetailHeader";
import { MapStatsDisplay } from "@/app/dashboard/map-assets/map-detail-sections/MapStatsDisplay";
import { DigitalTwinStatsDisplay } from "@/app/dashboard/map-assets/map-detail-sections/DigitalTwinStatsDisplay";
import { a11y, motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

interface AnalyticsTabProps {
  asset: MapAsset;
  viewMode?: ViewMode;
  threeDStats?: ThreeDStatsResponse | null;
  threeDStatsLoading?: boolean;
  candidateLocations?: CandidateLocation[];
  /** Dedup'd count of Overture crosswalks not covered by in-house data (≥0). */
  overtureCrosswalkSurvivors?: number;
  /** Enrichment snapshot — drives the Third-party data section in MapStatsDisplay. */
  enrichment?: MapAssetEnrichmentSnapshot | null;
}

export function AnalyticsTab({
  asset,
  viewMode = "2d",
  threeDStats,
  threeDStatsLoading,
  candidateLocations,
  overtureCrosswalkSurvivors,
  enrichment,
}: AnalyticsTabProps) {
  // 3D mode: show digital twin analytics
  if (viewMode === "3d") {
    if (threeDStatsLoading) {
      return (
        <div {...stylex.props(styles.loadingState)} role="status" aria-live="polite">
          <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingSpinner])} aria-hidden="true" />
          <span {...stylex.props(a11y.srOnly)}>Loading 3D statistics</span>
        </div>
      );
    }

    if (!threeDStats) {
      return (
        <div {...stylex.props(styles.emptyState)}>
          <div {...stylex.props(styles.emptyStateIconWrapper)}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(styles.emptyStateIcon)}
            >
              <path d="M3 3v18h18" />
              <path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </div>
          <p {...stylex.props(styles.emptyStateTitle)}>No 3D statistics available</p>
          <p {...stylex.props(styles.emptyStateDescription)}>
            Upload 3D digital twin assets to see scene analytics.
          </p>
        </div>
      );
    }

    return (
      <div>
        <DigitalTwinStatsDisplay stats={threeDStats} />
      </div>
    );
  }

  // 2D mode: existing road network stats
  const mapStats = asset.map_stats ?? null;

  if (!mapStats) {
    return (
      <div {...stylex.props(styles.emptyState)}>
        <div {...stylex.props(styles.emptyStateIconWrapper)}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            {...stylex.props(styles.emptyStateIcon)}
          >
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-3 3" />
          </svg>
        </div>
        <p {...stylex.props(styles.emptyStateTitle)}>No statistics available</p>
        <p {...stylex.props(styles.emptyStateDescription)}>
          Run &quot;Re-extract Metadata&quot; from the actions menu to compute map statistics.
        </p>
      </div>
    );
  }

  return (
    <div>
      <MapStatsDisplay
        stats={mapStats}
        candidateLocations={candidateLocations}
        overtureCrosswalkSurvivors={overtureCrosswalkSurvivors}
        enrichment={enrichment}
      />
    </div>
  );
}
