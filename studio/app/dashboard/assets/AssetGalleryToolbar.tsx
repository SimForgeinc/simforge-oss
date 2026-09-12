"use client";

import { ArrowUpDown, Loader2, Search, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { Toolbar, ToolbarGroup } from "@simforge-oss/studio-ui/components/ui/toolbar";
import type { GalleryActorClass } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import {
  GALLERY_ACTOR_CLASS_OPTIONS,
  GALLERY_CARLA_FILTER_OPTIONS,
  GALLERY_SORT_LABELS,
  GALLERY_SORT_ORDER,
  type GalleryCarlaFilter,
  type GallerySort,
} from "./gallery-filters";
import { dialog } from "./asset-dialogs.stylex";


export function AssetGalleryToolbar({
  query,
  onQueryChange,
  actorClass,
  onActorClassChange,
  carla,
  onCarlaChange,
  sort,
  onSortChange,
  resultCount,
  hasMore,
  searching,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  actorClass: GalleryActorClass | "all";
  onActorClassChange: (actorClass: GalleryActorClass | "all") => void;
  carla: GalleryCarlaFilter;
  onCarlaChange: (carla: GalleryCarlaFilter) => void;
  sort: GallerySort;
  onSortChange: (sort: GallerySort) => void;
  resultCount: number;
  /** A cursor is still outstanding, so both count and sort cover a prefix. */
  hasMore: boolean;
  searching: boolean;
}) {
  return (
    <Toolbar {...stylex.props(dialog.toolbar)}>
      <div {...stylex.props(dialog.searchWrap)}>
        {searching ? <Loader2 aria-hidden="true" {...stylex.props(dialog.searchIcon, dialog.progressPulse)} /> : <Search aria-hidden="true" {...stylex.props(dialog.searchIcon)} />}
        <Input
          type="search"
          aria-label="Search assets by title"
          placeholder="Search assets by title…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          // Native bridge: hide the browser's duplicate search clear button.
          className="[&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button type="button" aria-label="Clear search" onClick={() => onQueryChange("")} {...stylex.props(dialog.clearButton)}>
            <X aria-hidden="true" {...stylex.props(dialog.iconSm)} />
          </button>
        ) : null}
      </div>

      <SelectMenu
        value={actorClass}
        onChange={(value) => onActorClassChange(value as GalleryActorClass | "all")}
        options={GALLERY_ACTOR_CLASS_OPTIONS}
        label="Filter by actor class"
        {...stylex.props(dialog.toolbarSelect, dialog.toolbarActor)}
      />
      <SelectMenu
        value={carla}
        onChange={(value) => onCarlaChange(value as GalleryCarlaFilter)}
        options={GALLERY_CARLA_FILTER_OPTIONS}
        label="Filter by CARLA compatibility"
        {...stylex.props(dialog.toolbarSelect, dialog.toolbarCarla)}
      />

      <ToolbarGroup {...stylex.props(dialog.toolbarGroup)}>
        <p {...stylex.props(dialog.toolbarCount)}>
          <span {...stylex.props(dialog.toolbarCountValue)}>{resultCount}</span>{" "}
          {resultCount === 1 ? "asset" : "assets"}
          {hasMore ? " loaded" : ""}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              {...stylex.props(dialog.toolbarSort)}
              title={
                hasMore
                  ? "Sorts the assets loaded so far. Load more to sort across the rest of the library."
                  : undefined
              }
            >
              <ArrowUpDown aria-hidden="true" {...stylex.props(dialog.iconButton)} />
              Sort: {GALLERY_SORT_LABELS[sort]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as GallerySort)}>
              {GALLERY_SORT_ORDER.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {GALLERY_SORT_LABELS[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ToolbarGroup>
    </Toolbar>
  );
}
