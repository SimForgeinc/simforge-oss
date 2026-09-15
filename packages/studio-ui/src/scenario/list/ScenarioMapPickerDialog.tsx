"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioMapPickerDialog.stylex";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MapPin, Search, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { control, list } from "../scenario-controls.stylex";
import type { ScenarioMapOption } from "./document-map-groups";

function searchableText(map: ScenarioMapOption) {
  return [map.label, map.locality, map.mapVersionId].filter(Boolean).join(" ").toLowerCase();
}

/**
 * The map picker for "New Scenario".
 *
 * Ported from v1's `EditorMapPickerDialog`, with three things dropped because v2's map catalog does
 * not have them: the runtime toggle (v2 has exactly one CARLA runtime, so v1's single-option picker
 * was already inert chrome), the "bundle missing" gate (a `map_versions` row only exists once its
 * browser asset set is published, with `closure_sha256` proving the closure), and the deep link into
 * `/dashboard/map-assets`, which is v1's map surface.
 *
 * Thumbnail URLs are stable first-party routes backed by independently versioned Scenario
 * artifacts, so switching views never has to retain an expiring S3 URL.
 */
export function ScenarioMapPickerDialog({
  maps,
  currentMapVersionId,
  open,
  onOpenChange,
  onSelectMap,
}: {
  maps: ReadonlyArray<ScenarioMapOption>;
  currentMapVersionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectMap: (map: ScenarioMapOption) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  // Close on Escape, lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onOpenChange]);

  const sortedMaps = useMemo(
    () =>
      [...maps].sort((a, b) => {
        if (a.mapVersionId === currentMapVersionId) return -1;
        if (b.mapVersionId === currentMapVersionId) return 1;
        return a.label.localeCompare(b.label);
      }),
    [currentMapVersionId, maps],
  );
  const filteredMaps = useMemo(
    () =>
      normalizedQuery
        ? sortedMaps.filter((map) => searchableText(map).includes(normalizedQuery))
        : sortedMaps,
    [normalizedQuery, sortedMaps],
  );

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div {...stylex.props(styles.divFixedFlex)}>
      <button
        type="button"
        {...stylex.props(styles.closeMapPickerButton)}
        aria-label="Close map picker"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select map"
        {...stylex.props(styles.selectMap)}
      >
        <div {...stylex.props(styles.divFlex)}>
          <div {...stylex.props(styles.div)}>
            <h2 {...stylex.props(styles.selectMap2)}>
              Select Map
            </h2>
            <p {...stylex.props(styles.pXs)}>
              {filteredMaps.length} of {maps.length} maps
            </p>
          </div>
          <div {...stylex.props(styles.divFlex2)}>
            <div {...stylex.props(styles.divRelative)}>
              <Search
                {...stylex.props(styles.searchAbsoluteIcon)}
                aria-hidden="true"
              />
              <Input
                autoFocus
                aria-label="Search maps"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search maps"
                xstyle={list.mapSearchInput}
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              aria-label="Close map picker"
            >
              <X {...stylex.props(styles.xIcon)} aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div {...stylex.props(styles.div2)}>
          {filteredMaps.length === 0 ? (
            <div {...stylex.props(styles.divFlexSm)}>
              {maps.length === 0 ? "No maps available." : "No maps match your search."}
            </div>
          ) : (
            <div {...stylex.props(styles.divGrid)}>
              {filteredMaps.map((map) => {
                const isCurrent = map.mapVersionId === currentMapVersionId;
                return (
                  <div
                    key={map.mapVersionId}
                    className={cn(
                      "group overflow-hidden border bg-card transition-colors duration-200",
                      isCurrent
                        ? "border-primary ring-1 ring-primary/40"
                        : "border-border hover:border-primary/50",
                    )}
                  >
                    <div {...stylex.props(styles.divRelative2)}>
                      {map.thumbnailUrl ? (
                        <Image
                          src={map.thumbnailUrl}
                          alt={map.label}
                          fill
                          sizes="(max-width: 768px) 100vw, (max-width: 1280px) 33vw, 25vw"
                          className="object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                          // The route redirects to immutable media; image optimization adds no value.
                          unoptimized
                        />
                      ) : (
                        <div {...stylex.props(styles.div3)} />
                      )}
                      <div
                        aria-hidden="true"
                        {...stylex.props(styles.divAbsolute)}
                      />
                      {isCurrent ? (
                        <div {...stylex.props(styles.divAbsoluteFlexXs)}>
                          <Check {...stylex.props(styles.currentCheck)} aria-hidden="true" />
                          Current
                        </div>
                      ) : null}
                      <div {...stylex.props(styles.divAbsolute2)}>
                        {map.locality ? (
                          <div {...stylex.props(styles.divFlex3)}>
                            <MapPin {...stylex.props(styles.mappinIcon)} aria-hidden="true" />
                            <p {...stylex.props(styles.pTruncateXs)}>{map.locality}</p>
                          </div>
                        ) : null}
                        <p {...stylex.props(styles.pBaseBold)}>
                          {map.label}
                        </p>
                      </div>
                    </div>
                    <div {...stylex.props(styles.div4)}>
                      <Button
                        type="button"
                        xstyle={control.fullWidth}
                        variant={isCurrent ? "outline" : "default"}
                        onClick={() => {
                          onSelectMap(map);
                          onOpenChange(false);
                        }}
                      >
                        {isCurrent ? "Use This Map" : "Select Map"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
