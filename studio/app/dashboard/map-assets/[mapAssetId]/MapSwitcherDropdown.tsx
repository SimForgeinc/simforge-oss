"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useRef, useState, useMemo, useEffect } from "react";
import { ChevronDown, Search, Check } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";

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
          className={stylex.props(styles.s_749).className}
        >
          <span className={stylex.props(styles.s_750).className}>{currentAsset.name}</span>
          <ChevronDown className={stylex.props(styles.s_751).className} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" xstyle={styles.s_752} sideOffset={4}>
        {/* Search input */}
        <div className={stylex.props(styles.s_753).className}>
          <div className={stylex.props(styles.s_987).className}>
            <Search className={stylex.props(styles.s_755).className} />
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search maps..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              xstyle={styles.s_756}
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
        <div className={stylex.props(styles.s_757).className}>
          {filtered.length === 0 ? (
            <p className={stylex.props(styles.s_758).className}>No maps found</p>
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
                  className={stylex.props(styles.switcherItem, isCurrent ? styles.switcherItemCurrent : styles.switcherItemOther).className}
                >
                  {isCurrent ? (
                    <Check className={stylex.props(styles.s_759).className} />
                  ) : (
                    <div className={stylex.props(styles.s_760).className} />
                  )}
                  <div className={stylex.props(styles.s_761).className}>
                    <p className={stylex.props(styles.switcherLabel, isCurrent && styles.switcherLabelCurrent).className}>
                      {asset.name}
                    </p>
                    {place && (
                      <p className={stylex.props(styles.s_762).className}>{place}</p>
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
