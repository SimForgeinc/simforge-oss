"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./DatasetStrip.stylex";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ClipboardCheck, Plus } from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import type { ScenarioDatasetDto } from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { menu } from "../scenario-controls.stylex";
import { datasetHue, datasetMonogram } from "../../lib/monogram";

/** Datasets the workspace owns can be edited; shared and system-managed ones are read-only (§6.5). */
export function isDatasetEditable(dataset: ScenarioDatasetDto): boolean {
  return dataset.visibility === "workspace" && !dataset.isSystemManaged;
}

/**
 * The dataset strip: one square per dataset down the far left, in the manner of Slack's workspace
 * switcher and Discord's server list. Which dataset is open is the only state it shows; everything
 * about that dataset lives in the scenario column beside it.
 *
 * The strip owns no text. A monogram on a per-dataset hue is what the eye learns to find; the name is
 * one hover (or focus) away in the tooltip and always present as the button's accessible name.
 */
export function DatasetStrip({
  datasets,
  loading,
  creating,
  busyDatasetId,
  activeDatasetId,
  onSelectDataset,
  onPrefetchDataset,
  onOpenNewDatasetDialog,
  onEditDatasetDetails,
  onDeleteDataset,
}: {
  /** In display order; the strip draws a divider where the workspace's own datasets end. */
  datasets: ScenarioDatasetDto[];
  loading: boolean;
  creating: boolean;
  busyDatasetId: string | null;
  activeDatasetId: string | null;
  onSelectDataset: (datasetId: string) => void;
  onPrefetchDataset?: (datasetId: string) => void;
  onOpenNewDatasetDialog: () => void;
  onEditDatasetDetails: (dataset: ScenarioDatasetDto) => void;
  onDeleteDataset: (dataset: ScenarioDatasetDto) => void;
}) {
  const [hoveredDatasetId, setHoveredDatasetId] = useState<string | null>(null);
  const [menuDatasetId, setMenuDatasetId] = useState<string | null>(null);
  const owned = datasets.filter(isDatasetEditable);
  const shared = datasets.filter((dataset) => !isDatasetEditable(dataset));

  const renderIcon = (dataset: ScenarioDatasetDto) => {
    const active = dataset.id === activeDatasetId;
    const busy = dataset.id === busyDatasetId;
    const hovered = dataset.id === hoveredDatasetId;
    const menuOpen = dataset.id === menuDatasetId;
    const editable = isDatasetEditable(dataset);
    const hue = datasetHue(dataset.id);
    const count = dataset.documentCount;
    return (
      <li
        key={dataset.id}
        {...stylex.props(styles.item)}
        onMouseEnter={() => {
          setHoveredDatasetId(dataset.id);
          onPrefetchDataset?.(dataset.id);
        }}
        onMouseLeave={() =>
          setHoveredDatasetId((current) => (current === dataset.id ? null : current))
        }
        data-dataset-id={dataset.id}
      >
        <span
          {...stylex.props(
            styles.pill,
            active ? styles.pillActive : hovered || menuOpen ? styles.pillHover : null,
          )}
          aria-hidden="true"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label={dataset.name}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelectDataset(dataset.id)}
              onFocus={() => onPrefetchDataset?.(dataset.id)}
              onContextMenu={
                editable
                  ? (event) => {
                      event.preventDefault();
                      setMenuDatasetId(dataset.id);
                    }
                  : undefined
              }
              style={{ backgroundColor: active ? `hsl(${hue} 52% 42%)` : `hsl(${hue} 40% 30%)` }}
              {...stylex.props(
                styles.icon,
                active ? styles.iconActive : null,
                busy ? styles.iconBusy : null,
              )}
              data-testid="scenario-dataset-icon"
            >
              <span aria-hidden="true">{datasetMonogram(dataset.name)}</span>
              {busy ? (
                <span {...stylex.props(styles.busyOverlay)}>
                  <CloudActivityIndicator />
                </span>
              ) : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            <div {...stylex.props(styles.tooltipTitle)}>{dataset.name}</div>
            <div {...stylex.props(styles.tooltipMeta)}>
              {count} {count === 1 ? "scenario" : "scenarios"}
              {editable ? null : " · Read-only"}
            </div>
          </TooltipContent>
        </Tooltip>
        {editable ? (
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) =>
              setMenuDatasetId((current) =>
                open ? dataset.id : current === dataset.id ? null : current,
              )
            }
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                aria-label={`Dataset actions for ${dataset.name}`}
                {...stylex.props(
                  styles.caret,
                  hovered || menuOpen ? styles.caretRevealed : null,
                )}
              >
                <ChevronDown {...stylex.props(styles.caretIcon)} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" xstyle={menu.width160}>
              <DropdownMenuItem onSelect={() => onEditDatasetDetails(dataset)}>
                Edit details
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                xstyle={menu.destructiveItem}
                onSelect={() => onDeleteDataset(dataset)}
              >
                Delete dataset
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </li>
    );
  };

  return (
    <TooltipProvider delayDuration={150}>
      <nav
        {...stylex.props(styles.strip)}
        aria-label="Datasets"
        data-testid="scenario-dataset-rail"
      >
        <ul {...stylex.props(styles.list)}>
          {loading && datasets.length === 0
            ? [0, 1, 2].map((index) => (
                <li key={index} aria-hidden="true">
                  <Skeleton xstyle={styles.skeleton} />
                </li>
              ))
            : null}
          {owned.map(renderIcon)}
          {owned.length > 0 && shared.length > 0 ? (
            <li role="separator" {...stylex.props(styles.divider)} aria-hidden="true" />
          ) : null}
          {shared.map(renderIcon)}
        </ul>
        <div {...stylex.props(styles.footer)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                xstyle={styles.footerButton}
                disabled={creating}
                aria-label="New dataset"
                data-testid="scenario-new-dataset"
                onClick={onOpenNewDatasetDialog}
              >
                {creating ? (
                  <CloudActivityIndicator />
                ) : (
                  <Plus {...stylex.props(styles.footerIcon)} aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              New dataset
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild size="icon" variant="ghost" xstyle={styles.footerLink}>
                <Link href="/dashboard/scenario/review" aria-label="Review queue">
                  <ClipboardCheck {...stylex.props(styles.footerIcon)} aria-hidden="true" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              Review queue
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
