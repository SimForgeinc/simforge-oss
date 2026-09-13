"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  TopBarActionsPortal,
  TopBarTrailingPortal,
} from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@simforge-oss/studio-ui/components/ui/tooltip";
import { toast } from "sonner";
import { MapSwitcherDropdown } from "./MapSwitcherDropdown";

export type ViewMode = "2d" | "3d";

interface MapDetailHeaderProps {
  asset: MapAsset;
  allAssets: MapAsset[];
  onEdit: () => void;
  onPopulateMetadata: () => void;
  onEnrich: () => void;
  onRefreshSearchIndex: () => void;
  onGenerateThumbnail: () => void;
  onSwitchMap: (mapAssetId: string) => void;
  onCreateBlankScenario: () => void;
  canCreateBlankScenario?: boolean;
  populateBusy?: boolean;
  enrichBusy?: boolean;
  refreshSearchIndexBusy?: boolean;
  thumbnailBusy?: boolean;
  createBlankBusy?: boolean;
}

export function MapDetailHeader({
  asset,
  allAssets,
  onEdit,
  onPopulateMetadata,
  onEnrich,
  onRefreshSearchIndex,
  onGenerateThumbnail,
  onSwitchMap,
  onCreateBlankScenario,
  canCreateBlankScenario = true,
  populateBusy = false,
  enrichBusy = false,
  refreshSearchIndexBusy = false,
  thumbnailBusy = false,
  createBlankBusy = false,
}: MapDetailHeaderProps) {
  function copyMapId() {
    navigator.clipboard.writeText(asset.map_asset_id).then(() => {
      toast.success("Map ID copied");
    }).catch(() => {});
  }

  return (
    <>
      <TopBarActionsPortal>
        <div className={stylex.props(styles.s_718).className}>
          <Link
            href="/dashboard/map-assets"
            className={stylex.props(styles.s_719).className}
          >
            <ArrowLeft className={stylex.props(styles.s_991).className} />
            <span className={stylex.props(styles.s_721).className}>Back to Maps</span>
            <span className={stylex.props(styles.s_722).className}>Back</span>
          </Link>

          <div className={stylex.props(styles.s_723).className} />

          <MapSwitcherDropdown currentAsset={asset} allAssets={allAssets} onSwitchMap={onSwitchMap} />
        </div>
      </TopBarActionsPortal>

      <TopBarTrailingPortal>
        <Button
          variant="secondary"
          size="sm"
          xstyle={styles.s_724}
          onClick={onCreateBlankScenario}
          disabled={createBlankBusy || !canCreateBlankScenario}
          title={
            canCreateBlankScenario
              ? undefined
              : "This map is not available in CARLA yet."
          }
        >
          <Plus className={stylex.props(styles.s_991).className} />
          {createBlankBusy ? "Creating..." : "Create Blank Scenario"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              xstyle={styles.s_726}
            >
              <MoreHorizontal size={22} strokeWidth={1.75} />
              <span className={stylex.props(styles.s_997).className}>Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" xstyle={styles.s_728}>
            <TooltipProvider delayDuration={200}>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className={stylex.props(styles.s_732).className} />
                Edit Map
              </DropdownMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onPopulateMetadata}
                    disabled={populateBusy}
                  >
                    <RefreshCw
                      className={stylex.props(styles.headerActionIcon, populateBusy && styles.spinning).className}
                    />
                    Re-extract Metadata
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" xstyle={styles.s_731}>
                  Recalculate metadata and refresh the local search index.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem onClick={onEnrich} disabled>
                <RefreshCw
                  className={stylex.props(styles.headerActionIcon, enrichBusy && styles.spinning).className}
                />
                Enrichment unavailable locally
              </DropdownMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onRefreshSearchIndex}
                    disabled={refreshSearchIndexBusy}
                  >
                    <RefreshCw
                      className={stylex.props(styles.headerActionIcon, refreshSearchIndexBusy && styles.spinning).className}
                    />
                    Refresh Search Index
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" xstyle={styles.s_731}>
                  Refreshes the search index just from the current metadata — no repopulation or re-enrichment.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem
                onClick={onGenerateThumbnail}
                disabled={thumbnailBusy}
              >
                <Camera
                  className={stylex.props(styles.headerActionIcon, thumbnailBusy && styles.pulsing).className}
                />
                Generate Thumbnail
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyMapId}>
                <Copy className={stylex.props(styles.s_732).className} />
                Copy Map ID
              </DropdownMenuItem>
            </TooltipProvider>
          </DropdownMenuContent>
        </DropdownMenu>
      </TopBarTrailingPortal>
    </>
  );
}
