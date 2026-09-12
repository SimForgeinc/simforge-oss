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
import { cn } from "@simforge-oss/studio-ui/lib/utils";
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
          className={stylex.props(styles.s_724).className}
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
              className={stylex.props(styles.s_726).className}
            >
              <MoreHorizontal size={22} strokeWidth={1.75} />
              <span className={stylex.props(styles.s_997).className}>Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={stylex.props(styles.s_728).className}>
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
                      className={stylex.props(styles.u_932).className}
                    />
                    Re-extract Metadata
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" className={stylex.props(styles.s_731).className}>
                  Recalculate metadata and refresh the local search index.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem onClick={onEnrich} disabled>
                <RefreshCw
                  className={stylex.props(styles.u_932).className}
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
                      className={stylex.props(styles.u_932).className}
                    />
                    Refresh Search Index
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" className={stylex.props(styles.s_731).className}>
                  Refreshes the search index just from the current metadata — no repopulation or re-enrichment.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem
                onClick={onGenerateThumbnail}
                disabled={thumbnailBusy}
              >
                <Camera
                  className={stylex.props(styles.u_932).className}
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
