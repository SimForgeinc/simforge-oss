"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EnrichmentSection.stylex";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@simforge-oss/studio-ui/components/ui/tooltip";
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
      <div {...stylex.props(styles.headerRow)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props(styles.sectionToggle)}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props(styles.chevron, open && styles.rotate90)}
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
                  {...stylex.props(styles.enrichIconButton)}
                  aria-label="Run 3rd-party enrichment"
                >
                  {enrichBusy ? (
                    <Loader2 {...stylex.props(styles.enrichLoadingIcon)} />
                  ) : (
                    <Sparkles {...stylex.props(styles.enrichSparklesIcon)} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" xstyle={styles.enrichTooltip}>
                {enrichment ? "Re-run 3rd-party enrichment (replaces existing)" : "Run 3rd-party enrichment (1–2 min)"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open && (
        <div {...stylex.props(styles.contentPanel)}>
          {enrichmentLoading && (
            <p {...stylex.props(styles.statusText)}>Loading saved snapshot…</p>
          )}
          {!enrichmentLoading && !enrichment && (
            /* `space-y-2` lives on the children here: `Button` is inline-flex, so
               a flex column would blockify it and lose its line-box leading. */
            <div>
              <p {...stylex.props(styles.emptyStateText, styles.stackY2)}>
                No enrichment snapshot yet. Run 3rd-party enrichment to pull bus stops,
                schools, hospitals, and named road segments for this map.
              </p>
              {showEnrich && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  xstyle={[styles.enrichButton, styles.stackY2]}
                  disabled={enrichBusy}
                  onClick={onEnrich}
                >
                  {enrichBusy ? (
                    <>
                      <Loader2 {...stylex.props(styles.buttonLoadingIcon)} />
                      Enriching… (1–2 min)
                    </>
                  ) : (
                    <>
                      <Sparkles {...stylex.props(styles.buttonSparklesIcon)} />
                      Run 3rd-party enrichment
                    </>
                  )}
                </Button>
              )}
              {enrichErr && <p {...stylex.props(styles.emptyStateError, styles.stackY2)}>{enrichErr}</p>}
            </div>
          )}
          {enrichment && (
            <>
              <p {...stylex.props(styles.statusText)}>
                Enrichment data loaded. See <span {...stylex.props(styles.provenanceLabel)}>Map Provenance</span> for source details.
              </p>
              {enrichErr && <p {...stylex.props(styles.loadedError)}>{enrichErr}</p>}
              {attribution && (
                <p {...stylex.props(styles.attributionText)}>
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
