"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapDetailHeader.stylex";

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
import { useRouteHeader } from "@simforge-oss/studio-ui/components/TopBarSlot";
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
import { a11y, focus, motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

export type ViewMode = "2d" | "3d";

interface MapDetailHeaderProps {
  asset: MapAsset;
  allAssets: MapAsset[];
  onEdit: () => void;
  onPopulateMetadata: () => void;
  onRefreshSearchIndex: () => void;
  onGenerateThumbnail: () => void;
  onSwitchMap: (mapAssetId: string) => void;
  onCreateBlankScenario: () => void;
  canCreateBlankScenario?: boolean;
  populateBusy?: boolean;
  refreshSearchIndexBusy?: boolean;
  thumbnailBusy?: boolean;
  createBlankBusy?: boolean;
}

export function MapDetailHeader({
  asset,
  allAssets,
  onEdit,
  onPopulateMetadata,
  onRefreshSearchIndex,
  onGenerateThumbnail,
  onSwitchMap,
  onCreateBlankScenario,
  canCreateBlankScenario = true,
  populateBusy = false,
  refreshSearchIndexBusy = false,
  thumbnailBusy = false,
  createBlankBusy = false,
}: MapDetailHeaderProps) {
  function copyMapId() {
    navigator.clipboard.writeText(asset.map_asset_id).then(() => {
      toast.success("Map ID copied");
    }).catch(() => {});
  }

  useRouteHeader({
    title: asset.name,
    actions: (
      <>
        <div {...stylex.props(styles.headerNavigationGroup)}>
          <Link
            href="/dashboard/map-assets"
            {...stylex.props([focus.ring, motionRecipe.colors, styles.backToMapsLink])}
          >
            <ArrowLeft {...stylex.props(styles.sharedActionIcon)} />
            <span {...stylex.props(styles.backToMapsLabel)}>Back to Maps</span>
            <span {...stylex.props(styles.backLabel)}>Back</span>
          </Link>

          <div {...stylex.props(styles.headerNavigationDivider)} />

          <MapSwitcherDropdown currentAsset={asset} allAssets={allAssets} onSwitchMap={onSwitchMap} />
        </div>
        <Button
          variant="secondary"
          size="sm"
          xstyle={styles.createScenarioButton}
          onClick={onCreateBlankScenario}
          disabled={createBlankBusy || !canCreateBlankScenario}
          title={
            canCreateBlankScenario
              ? undefined
              : "This map is not available in CARLA yet."
          }
        >
          <Plus {...stylex.props(styles.sharedActionIcon)} />
          {createBlankBusy ? "Creating..." : "Create Blank Scenario"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              xstyle={[motionRecipe.colors, styles.actionsMenuTrigger]}
            >
              <MoreHorizontal size={22} strokeWidth={1.75} />
              <span {...stylex.props(a11y.srOnly)}>Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" xstyle={styles.actionsMenuContent}>
            <TooltipProvider delayDuration={200}>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil {...stylex.props(styles.menuItemIcon)} />
                Edit Map
              </DropdownMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onPopulateMetadata}
                    disabled={populateBusy}
                  >
                    <RefreshCw
                      {...stylex.props(styles.headerActionIcon, populateBusy && motionRecipe.spin)}
                    />
                    Re-extract Metadata
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" xstyle={styles.actionTooltip}>
                  Recalculate metadata and refresh the search index.
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onRefreshSearchIndex}
                    disabled={refreshSearchIndexBusy}
                  >
                    <RefreshCw
                      {...stylex.props(styles.headerActionIcon, refreshSearchIndexBusy && motionRecipe.spin)}
                    />
                    Refresh Search Index
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" xstyle={styles.actionTooltip}>
                  Refreshes the search index just from the current metadata — no repopulation or re-enrichment.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem
                onClick={onGenerateThumbnail}
                disabled={thumbnailBusy}
              >
                <Camera
                  {...stylex.props(styles.headerActionIcon, thumbnailBusy && motionRecipe.pulse)}
                />
                Generate Thumbnail
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyMapId}>
                <Copy {...stylex.props(styles.menuItemIcon)} />
                Copy Map ID
              </DropdownMenuItem>
            </TooltipProvider>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
  });
  return null;
}
