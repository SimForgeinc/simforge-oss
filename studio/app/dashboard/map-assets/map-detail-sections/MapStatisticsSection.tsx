"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Check, Copy } from "lucide-react";
import type { CandidateLocation, MapStats } from "@simforge-oss/studio-shared";
import { MapStatsDisplay } from "./MapStatsDisplay";
import { cn } from "@simforge-oss/studio-ui/lib/utils";

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
      <div className={stylex.props(styles.s_961).className}>
        <button
          type="button"
          onClick={onToggleOpen}
          className={stylex.props(styles.s_962).className}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
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
            className={stylex.props(styles.s_713).className}
          >
            {copiedKey === "mapStats" ? (
              <Check className={stylex.props(styles.s_714).className} />
            ) : (
              <Copy className={stylex.props(styles.s_927).className} />
            )}
          </button>
        )}
      </div>
      {open &&
        (mapStats != null ? (
          <div className={stylex.props(styles.s_716).className}>
            <MapStatsDisplay stats={mapStats} candidateLocations={candidateLocations} />
          </div>
        ) : (
          <p className={stylex.props(styles.s_717).className}>
            No statistics yet. They appear here after map metadata has been computed (requires geojson, xodr, and
            rrdata_xml on the asset).
          </p>
        ))}
    </section>
  );
}
