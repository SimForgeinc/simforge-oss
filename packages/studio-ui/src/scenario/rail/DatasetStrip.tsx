"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./DatasetStrip.stylex";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ClipboardCheck, Cloud, Plus } from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import type { ScenarioDatasetDto } from "../../lib/scenario/contracts";
import type { DatasetCloudHome } from "./dataset-home";
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
import { datasetMonogram } from "../../lib/monogram";
import { a11y } from "../../stylex/recipes.stylex";

/** Datasets the workspace owns can be edited; shared and system-managed ones are read-only (§6.5). */
export function isDatasetEditable(dataset: ScenarioDatasetDto): boolean {
  return dataset.visibility === "workspace" && !dataset.isSystemManaged;
}

/** Where the SimCloud panel — sign-in, and the import/publish actions — lives. */
const SIMCLOUD_HREF = "/dashboard/simcloud";

/**
 * How many of an organization's datasets the rail draws before it stops counting on screen.
 *
 * An organization can own hundreds of datasets, and a vertical rail of hundreds of 2.5rem tiles is
 * not a browsing surface — it is a scroll the eye cannot hold, mounted above the local section the
 * user actually works in. Past this many the section draws one honest marker for the remainder and
 * sends the user to the panel that lists them properly.
 */
const CLOUD_TILE_LIMIT = 24;

/**
 * The dataset strip: one square per dataset down the far left, in the manner of Slack's workspace
 * switcher and Discord's server list. Which dataset is open is the only per-dataset state it shows;
 * everything about that dataset lives in the scenario column beside it.
 *
 * ## Two homes, named as facts
 *
 * The strip is divided by *where a dataset lives*, because that is the one thing about a dataset the
 * product cannot express any other way: a dataset's home is this installation or one SimCloud
 * organization, and it is never both (`docs/engineering/local-cloud-boundary.md` §2, §7). The
 * sections are labelled with the concrete answer — "On this computer", then the organization's own
 * name — rather than "Local" and "Cloud", which name a taxonomy instead of a place.
 *
 * Home is a *section*, not a badge and not a filter: a badge would invite a second badge for a
 * "synced" state, and a filter would let the user hide the distinction the sections exist to make.
 * Each dataset is rendered by exactly one section; the two lists come from two origins and share no
 * rows, so there is nothing to deduplicate and no third state to draw.
 *
 * Cloud tiles are presence, not navigation. Opening a dataset means opening it from its home, and
 * the actions that cross homes (import, publish) belong to the SimCloud panel, which the cloud
 * section links to. So a cloud tile states its name, its size and its organization, and does not
 * pretend the local scenario column can open it.
 *
 * Apart from the labels the strip still owns no text: a monogram on a neutral tile is what the eye
 * learns to find, and the name is one hover (or focus) away in the tooltip and always present as the
 * tile's accessible name. Tiles are monochrome — state is carried by brightness, the pill and the
 * active ring, never by a per-dataset colour competing with the scene beside the rail.
 */
export function DatasetStrip({
  datasets,
  cloudHome,
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
  /** The datasets whose home is this installation, in display order. */
  datasets: ScenarioDatasetDto[];
  /** The connected organization's datasets, or why there are none to show. */
  cloudHome: DatasetCloudHome;
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
  const managed = cloudHome.state === "managed" || cloudHome.state === "managed-loading" || cloudHome.state === "managed-unavailable";
  const workspaceName = cloudHome.state === "managed" ? cloudHome.workspaceName : "Workspace";
  const [hoveredDatasetId, setHoveredDatasetId] = useState<string | null>(null);
  const [menuDatasetId, setMenuDatasetId] = useState<string | null>(null);
  const owned = datasets.filter(isDatasetEditable);
  const shared = datasets.filter((dataset) => !isDatasetEditable(dataset));

  const renderSectionLabel = (label: string, title: string, note?: string) => (
    <li role="presentation" {...stylex.props(styles.section)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span {...stylex.props(styles.sectionLabel)} tabIndex={0}>
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={12}>
          <div {...stylex.props(styles.tooltipTitle)}>{title}</div>
        </TooltipContent>
      </Tooltip>
      {note ? <span {...stylex.props(styles.sectionNote)}>{note}</span> : null}
    </li>
  );

  /** A dataset at this installation: selectable, renameable, deletable. */
  const renderLocalIcon = (dataset: ScenarioDatasetDto) => {
    const active = dataset.id === activeDatasetId;
    const busy = dataset.id === busyDatasetId;
    const hovered = dataset.id === hoveredDatasetId;
    const menuOpen = dataset.id === menuDatasetId;
    const editable = isDatasetEditable(dataset);
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

  /**
   * A dataset whose home is the organization. Presence only: it has no local scenario column to
   * open, and moving it between homes is not a thing this strip does.
   */
  const renderCloudIcon = (dataset: ScenarioDatasetDto, organizationName: string) => {
    const reveal = dataset.id === hoveredDatasetId;
    return (
      <li
        key={dataset.id}
        {...stylex.props(styles.item)}
        onMouseEnter={() => setHoveredDatasetId(dataset.id)}
        onMouseLeave={() =>
          setHoveredDatasetId((current) => (current === dataset.id ? null : current))
        }
        data-dataset-id={dataset.id}
      >
        {/*
          The name reveal is driven from this row's own hover/focus state rather than left to the
          tooltip's pointer heuristics. Those heuristics are written for an interactive trigger, and
          a cloud tile deliberately is not one: measured on this rail, an uncontrolled tooltip on a
          non-interactive trigger opened on focus but stayed `closed` on a real pointer hover, so the
          hover-reveal name the rail depends on was simply missing for cloud datasets. Controlling
          `open` makes the reveal identical for both homes and independent of that heuristic.
        */}
        <Tooltip open={reveal}>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="img"
              aria-label={`${dataset.name} — in ${organizationName}`}
              onFocus={() => setHoveredDatasetId(dataset.id)}
              onBlur={() =>
                setHoveredDatasetId((current) => (current === dataset.id ? null : current))
              }
              {...stylex.props(styles.icon, styles.iconStatic)}
              data-testid="scenario-cloud-dataset-icon"
            >
              <span aria-hidden="true">{datasetMonogram(dataset.name)}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            <div {...stylex.props(styles.tooltipTitle)}>{dataset.name}</div>
            <div {...stylex.props(styles.tooltipMeta)}>
              {dataset.documentCount} {dataset.documentCount === 1 ? "scenario" : "scenarios"} · In{" "}
              {organizationName}
            </div>
          </TooltipContent>
        </Tooltip>
      </li>
    );
  };

  /**
   * The cloud section. Every branch says where the datasets are or why they are not here; none of
   * them renders an unexplained gap.
   */
  const renderCloudSection = () => {
    // The managed workspace's rows are the primary section, not a second home.
    if (cloudHome.state === "managed" || cloudHome.state === "managed-loading" || cloudHome.state === "managed-unavailable") return null;
    if (cloudHome.state === "loading") {
      return (
        <>
          {renderSectionLabel("SimCloud", "Reading your SimCloud organization")}
          <li role="presentation" aria-hidden="true">
            <Skeleton xstyle={styles.skeleton} />
          </li>
        </>
      );
    }
    if (cloudHome.state === "signed-out") {
      return (
        <>
          {renderSectionLabel(
            "SimCloud",
            "Sign in to SimCloud to see the datasets your organization owns",
            "Signed out",
          )}
          <li {...stylex.props(styles.item)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon" variant="ghost" xstyle={styles.connectButton}>
                  <Link href={SIMCLOUD_HREF} data-testid="scenario-dataset-cloud-connect">
                    <Cloud {...stylex.props(styles.footerIcon)} aria-hidden="true" />
                    <span {...stylex.props(a11y.srOnly)}>Sign in to SimCloud</span>
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={12}>
                <div {...stylex.props(styles.tooltipTitle)}>Sign in to SimCloud</div>
                <div {...stylex.props(styles.tooltipMeta)}>
                  To see datasets your organization owns
                </div>
              </TooltipContent>
            </Tooltip>
          </li>
        </>
      );
    }
    if (cloudHome.state === "unavailable") {
      return renderSectionLabel("SimCloud", cloudHome.message, "Unavailable");
    }
    // One organization is shown. If the account has others, the heading's tooltip says how many, and
    // an empty section still distinguishes "this organization owns none" from "not connected".
    const others = cloudHome.organizationCount - 1;
    const scope =
      others > 0
        ? ` This account belongs to ${cloudHome.organizationCount} organizations; showing the active one.`
        : "";
    if (cloudHome.datasets.length === 0) {
      return renderSectionLabel(
        cloudHome.organizationName,
        `${cloudHome.organizationName} owns no datasets yet.${scope}`,
        others > 0 ? `No datasets · 1 of ${cloudHome.organizationCount} orgs` : "No datasets",
      );
    }
    const shown = cloudHome.datasets.slice(0, CLOUD_TILE_LIMIT);
    const hidden = cloudHome.datasets.length - shown.length;
    return (
      <>
        {renderSectionLabel(
          cloudHome.organizationName,
          `Datasets owned by ${cloudHome.organizationName}.${scope}`,
          others > 0 ? `1 of ${cloudHome.organizationCount} orgs` : undefined,
        )}
        {shown.map((dataset) => renderCloudIcon(dataset, cloudHome.organizationName))}
        {hidden > 0 ? (
          <li {...stylex.props(styles.item)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon" variant="ghost" xstyle={styles.overflowButton}>
                  <Link href={SIMCLOUD_HREF} data-testid="scenario-dataset-cloud-overflow">
                    <span aria-hidden="true">+{hidden}</span>
                    <span {...stylex.props(a11y.srOnly)}>
                      {hidden} more datasets in {cloudHome.organizationName}
                    </span>
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={12}>
                <div {...stylex.props(styles.tooltipTitle)}>
                  {hidden} more {hidden === 1 ? "dataset" : "datasets"}
                </div>
                <div {...stylex.props(styles.tooltipMeta)}>
                  In {cloudHome.organizationName} · Open SimCloud
                </div>
              </TooltipContent>
            </Tooltip>
          </li>
        ) : null}
      </>
    );
  };

  return (
    <TooltipProvider delayDuration={150}>
      <nav
        {...stylex.props(styles.strip)}
        aria-label="Datasets by home"
        data-testid="scenario-dataset-rail"
      >
        <ul {...stylex.props(styles.list)}>
          {managed
            ? renderSectionLabel(workspaceName, `Datasets stored in ${workspaceName}`)
            : renderSectionLabel("On this computer", "Datasets stored on this computer")}
          {loading && datasets.length === 0
            ? [0, 1, 2].map((index) => (
                <li key={index} role="presentation" aria-hidden="true">
                  <Skeleton xstyle={styles.skeleton} />
                </li>
              ))
            : null}
          {owned.map(renderLocalIcon)}
          {!managed && owned.length > 0 && shared.length > 0 ? (
            <li role="separator" {...stylex.props(styles.divider)} aria-hidden="true" />
          ) : null}
          {!managed ? shared.map(renderLocalIcon) : null}
          {managed ? null : renderCloudSection()}
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
              {managed ? `New dataset in ${workspaceName}` : "New dataset on this computer"}
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
