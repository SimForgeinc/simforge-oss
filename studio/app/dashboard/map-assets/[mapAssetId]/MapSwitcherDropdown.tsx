"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapSwitcherDropdown.stylex";

import { useRef, useState, useMemo, useEffect } from "react";
import { ChevronDown, Search, Check } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { motionRecipe, textLayout } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

interface MapSwitcherDropdownProps {
  currentAsset: MapAsset;
  allAssets: MapAsset[];
  onSwitchMap: (mapAssetId: string) => void;
}

export function MapSwitcherDropdown({ currentAsset, allAssets, onSwitchMap }: MapSwitcherDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allAssets;
    return allAssets.filter((a) => {
      const place = a.place_context
        ? [a.place_context.city, a.place_context.state, a.place_context.country]
            .filter(Boolean)
            .join(" ")
        : "";
      const corpus = `${a.name} ${place}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [allAssets, query]);

  function switchToMap(mapAssetId: string) {
    onSwitchMap(mapAssetId);
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          {...stylex.props([motionRecipe.colors, styles.dropdownTrigger])}
        >
          <span {...stylex.props([textLayout.truncate, styles.currentMapName])}>{currentAsset.name}</span>
          <ChevronDown {...stylex.props(styles.dropdownChevron)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" xstyle={styles.dropdownContent} sideOffset={4}>
        {/* Search input */}
        <div {...stylex.props(styles.searchSection)}>
          <div {...stylex.props(styles.searchFieldWrapper)}>
            <Search {...stylex.props(styles.searchIcon)} />
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search maps..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              xstyle={styles.searchInput}
              onKeyDown={(e) => {
                // Prevent dropdown from closing on key presses
                e.stopPropagation();
                // Enter selects first result
                if (e.key === "Enter" && filtered.length > 0) {
                  const first = filtered[0]!;
                  if (first.map_asset_id !== currentAsset.map_asset_id) {
                    switchToMap(first.map_asset_id);
                  }
                }
              }}
            />
          </div>
        </div>

        {/* Map list */}
        <div {...stylex.props(styles.mapList)}>
          {filtered.length === 0 ? (
            <p {...stylex.props(styles.noResultsMessage)}>No maps found</p>
          ) : (
            filtered.map((asset) => {
              const isCurrent = asset.map_asset_id === currentAsset.map_asset_id;
              const place = asset.place_context
                ? [
                    asset.place_context.city,
                    asset.place_context.state,
                    asset.place_context.country_code?.toUpperCase(),
                  ]
                    .filter(Boolean)
                    .join(", ")
                : null;

              return (
                <button
                  key={asset.map_asset_id}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) switchToMap(asset.map_asset_id);
                    setOpen(false);
                  }}
                  {...stylex.props([motionRecipe.colors, styles.switcherItem], isCurrent ? styles.switcherItemCurrent : styles.switcherItemOther)}
                >
                  {isCurrent ? (
                    <Check {...stylex.props(styles.selectedMapIcon)} />
                  ) : (
                    <div {...stylex.props(styles.unselectedMapIndicator)} />
                  )}
                  <div {...stylex.props(styles.mapItemText)}>
                    <p {...stylex.props([textLayout.truncate, styles.switcherLabel], isCurrent && styles.switcherLabelCurrent)}>
                      {asset.name}
                    </p>
                    {place && (
                      <p {...stylex.props([textLayout.truncate, styles.mapLocation])}>{place}</p>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
