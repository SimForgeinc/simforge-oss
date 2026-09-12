"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@simforge-oss/studio-ui/components/ui/tooltip";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import type { MapAssetEnrichmentSnapshot } from "@simforge-oss/studio-shared";

type EnrichmentSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  showEnrich: boolean;
  enrichBusy: boolean;
  enrichErr: string | null;
  onEnrich: () => void;
};

/** Display third-party Overture enrichment snapshot and trigger enrichment
 *  runs. The parent enqueues the job and polls /enrichment/status,
 *  reflecting progress through the busy + error props. Standalone
 *  street-name resolution is now a header-level action (see
 *  MapDetailHeader). */
export function EnrichmentSection({
  open,
  onToggleOpen,
  enrichment,
  enrichmentLoading,
  showEnrich,
  enrichBusy,
  enrichErr,
  onEnrich,
}: EnrichmentSectionProps) {
  const attribution = enrichment?.summary?.attribution;
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
          Third-Party Enrichment
        </button>
        {showEnrich && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onEnrich}
                  disabled={enrichBusy}
                  className={stylex.props(styles.s_440).className}
                  aria-label="Run 3rd-party enrichment"
                >
                  {enrichBusy ? (
                    <Loader2 className={stylex.props(styles.s_972).className} />
                  ) : (
                    <Sparkles className={stylex.props(styles.s_927).className} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className={stylex.props(styles.s_948).className}>
                {enrichment ? "Re-run 3rd-party enrichment (replaces existing)" : "Run 3rd-party enrichment (1–2 min)"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open && (
        <div className={stylex.props(styles.s_663).className}>
          {enrichmentLoading && (
            <p className={stylex.props(styles.s_973).className}>Loading saved snapshot…</p>
          )}
          {!enrichmentLoading && !enrichment && (
            <div className={stylex.props(styles.s_960).className}>
              <p className={stylex.props(styles.s_881).className}>
                No enrichment snapshot yet. Run 3rd-party enrichment to pull bus stops,
                schools, hospitals, and named road segments for this map.
              </p>
              {showEnrich && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={stylex.props(styles.s_708).className}
                  disabled={enrichBusy}
                  onClick={onEnrich}
                >
                  {enrichBusy ? (
                    <>
                      <Loader2 className={stylex.props(styles.s_709).className} />
                      Enriching… (1–2 min)
                    </>
                  ) : (
                    <>
                      <Sparkles className={stylex.props(styles.s_596).className} />
                      Run 3rd-party enrichment
                    </>
                  )}
                </Button>
              )}
              {enrichErr && <p className={stylex.props(styles.s_451).className}>{enrichErr}</p>}
            </div>
          )}
          {enrichment && (
            <>
              <p className={stylex.props(styles.s_973).className}>
                Enrichment data loaded. See <span className={stylex.props(styles.s_665).className}>Map Provenance</span> for source details.
              </p>
              {enrichErr && <p className={stylex.props(styles.s_710).className}>{enrichErr}</p>}
              {attribution && (
                <p className={stylex.props(styles.s_455).className}>
                  {attribution}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
