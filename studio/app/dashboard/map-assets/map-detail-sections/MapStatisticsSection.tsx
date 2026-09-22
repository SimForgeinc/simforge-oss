"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapStatisticsSection.stylex";

import { ChevronRight, Check, Copy } from "lucide-react";
import type { CandidateLocation, MapStats } from "@simforge-oss/studio-shared";
import { MapStatsDisplay } from "./MapStatsDisplay";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/** Props for the MapStatisticsSection component. */
type MapStatisticsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  mapStats: MapStats | null;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  candidateLocations?: CandidateLocation[];
};

/** Display collapsible map statistics section with copy-to-clipboard support. */
export function MapStatisticsSection({
  open,
  onToggleOpen,
  mapStats,
  copiedKey,
  onCopy,
  candidateLocations,
}: MapStatisticsSectionProps) {
  return (
    <section>
      <div {...stylex.props(styles.statisticsHeader)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props([motionRecipe.colors, styles.statisticsToggle])}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
          />
          Map Statistics
        </button>
        {mapStats != null && (
          <button
            type="button"
            onClick={() =>
              onCopy(JSON.stringify(mapStats, null, 2), "mapStats")
            }
            aria-label="Copy map statistics as JSON"
            title="Copy map statistics as JSON"
            {...stylex.props([motionRecipe.colors, styles.copyStatsButton])}
          >
            {copiedKey === "mapStats" ? (
              <Check {...stylex.props(styles.copiedCheckIcon)} />
            ) : (
              <Copy {...stylex.props(styles.copyStatsIcon)} />
            )}
          </button>
        )}
      </div>
      {open &&
        (mapStats != null ? (
          <div {...stylex.props(styles.statisticsContent)}>
            <MapStatsDisplay stats={mapStats} candidateLocations={candidateLocations} />
          </div>
        ) : (
          <p {...stylex.props(styles.noStatisticsMessage)}>
            No statistics yet. They appear here after map metadata has been computed (requires geojson, xodr, and
            rrdata_xml on the asset).
          </p>
        ))}
    </section>
  );
}
