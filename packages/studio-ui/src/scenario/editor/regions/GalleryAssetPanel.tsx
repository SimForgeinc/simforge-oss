"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { EditorController, EditorState } from "@simforge-oss/editor";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import { CarlaCompatibilityPill } from "../../../components/CarlaCompatibilityPill";
import type { CarlaCompatibility } from "../../../lib/scenario/carla-compatibility";
import type { GalleryAssetSummary } from "../../../lib/asset-gallery/contracts";
import { resolveGalleryCatalogIds } from "../../../lib/asset-gallery/editor-bridge";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./GalleryAssetPanel.stylex";

const PAGE_SIZE = 24;
const CATALOG_DRAG_TYPE = "application/x-simforge-catalog-id";
const GALLERY_COMPATIBILITY: CarlaCompatibility = {
  status: "browser-only",
  reason:
    "User-uploaded model has no CARLA runtime blueprint; it renders in browser preview and browser-recorded renders only.",
};

export function GalleryAssetPanel({
  controller,
  state,
  favorites,
  onFavorite,
  onRemember,
}: {
  controller: EditorController;
  state: EditorState | null;
  favorites: ReadonlySet<string>;
  onFavorite: (catalogId: string) => void;
  onRemember: (catalogId: CatalogId) => void;
}) {
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<GalleryAssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [armingId, setArmingId] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const trimmedQuery = query.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 250);
    return () => window.clearTimeout(timeout);
  }, [trimmedQuery]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (mine) params.set("mine", "1");
    void fetch(`/api/asset-gallery?${params}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load gallery assets (${response.status}).`);
        return response.json() as Promise<{
          items: GalleryAssetSummary[];
          nextCursor: string | null;
        }>;
      })
      .then(async (page) => {
        if (abort.signal.aborted) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        const missing = new Set(await resolveGalleryCatalogIds(page.items.map((item) => item.catalogId)));
        if (abort.signal.aborted) return;
        setResolved(new Set(page.items.filter((item) => !missing.has(item.catalogId)).map((item) => item.catalogId)));
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string } | null)?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [debouncedQuery, mine]);

  const visibleItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.catalogId)) return false;
      seen.add(item.catalogId);
      return true;
    });
  }, [items]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cursor: nextCursor, limit: String(PAGE_SIZE) });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (mine) params.set("mine", "1");
      const response = await fetch(`/api/asset-gallery?${params}`);
      if (!response.ok) throw new Error(`Could not load gallery assets (${response.status}).`);
      const page = (await response.json()) as {
        items: GalleryAssetSummary[];
        nextCursor: string | null;
      };
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      const missing = new Set(await resolveGalleryCatalogIds(page.items.map((item) => item.catalogId)));
      setResolved((current) => {
        const next = new Set(current);
        for (const item of page.items) {
          if (!missing.has(item.catalogId)) next.add(item.catalogId);
        }
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const choose = async (catalogId: string) => {
    setArmingId(catalogId);
    setError(null);
    try {
      const missing = await resolveGalleryCatalogIds([catalogId]);
      if (missing.length) throw new Error("This gallery asset is no longer available.");
      setResolved((current) => new Set(current).add(catalogId));
      if (state?.placing !== catalogId) controller.togglePlacement(catalogId as CatalogId);
      onRemember(catalogId as CatalogId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArmingId(null);
    }
  };

  const beginDrag = (event: DragEvent, catalogId: string) => {
    // Pages are resolved as they arrive, so registration is complete before a
    // native drag can begin. An unavailable tile never emits a catalog payload.
    if (!resolved.has(catalogId)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(CATALOG_DRAG_TYPE, catalogId);
    event.dataTransfer.setData("text/plain", catalogId);
    onRemember(catalogId as CatalogId);
  };

  return (
    <div data-testid="gallery-asset-panel">
      <p {...stylex.props(styles.relaxed, styles.stackedLg)}>
        Gallery models render in the browser and browser-recorded renders, not in CARLA.
      </p>
      <input
        aria-label="Search asset gallery"
        {...stylex.props(styles.whiteBorderedWide, styles.stackedLg)}
        placeholder="Search asset gallery…"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div aria-label="Gallery ownership" {...stylex.props(styles.flexGap1, styles.stackedLg)} role="group">
        {([false, true] as const).map((owned) => (
          <button
            aria-pressed={mine === owned}
            {...stylex.props(styles.ownershipChip, mine === owned ? styles.ownershipChipActive : styles.ownershipChipIdle)}
            key={String(owned)}
            type="button"
            onClick={() => setMine(owned)}
          >
            {owned ? "Mine" : "All"}
          </button>
        ))}
      </div>

      {visibleItems.length ? (
        <div {...stylex.props(styles.gridCols2Gap2, styles.stackedLg)}>
          {visibleItems.map((asset) => {
            const available = resolved.has(asset.catalogId);
            const active = state?.placing === asset.catalogId;
            return (
              <div
                {...stylex.props(styles.tile, active ? styles.tileActive : styles.tileIdle)}
                key={asset.catalogId}
                title={asset.description ?? asset.title}
              >
                <div
                  aria-disabled={!available}
                  aria-label={`Place ${asset.title}`}
                  {...stylex.props(styles.tileGrip, !available && styles.tileGripWaiting)}
                  draggable={available}
                  role="button"
                  tabIndex={0}
                  onClick={() => void choose(asset.catalogId)}
                  onDragStart={(event) => beginDrag(event, asset.catalogId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void choose(asset.catalogId);
                    }
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned S3 thumbnail; see AssetGalleryClient */}
                  <img
                    alt=""
                    {...stylex.props(styles.wideSquareContain)}
                    draggable={false}
                    loading="lazy"
                    src={asset.thumbnailUrl}
                  />
                  <div {...stylex.props(styles.narrowable)}>
                    <strong {...stylex.props(styles.blockSemiboldTruncate)}>
                      {asset.title}
                    </strong>
                    <span {...stylex.props(styles.blockTruncate)}>
                      v{asset.version} · {asset.dims.l.toFixed(1)} × {asset.dims.w.toFixed(1)} m
                    </span>
                    <div {...stylex.props(styles.mt15)}>
                      <CarlaCompatibilityPill compatibility={GALLERY_COMPATIBILITY} size="sm" />
                    </div>
                  </div>
                </div>
                <button
                  aria-label={`${favorites.has(asset.catalogId) ? "Remove" : "Add"} ${asset.title} ${favorites.has(asset.catalogId) ? "from" : "to"} favorites`}
                  aria-pressed={favorites.has(asset.catalogId)}
                  {...stylex.props(styles.favoriteToggle, favorites.has(asset.catalogId) ? styles.favoriteToggleOn : styles.favoriteToggleOff)}
                  type="button"
                  onClick={() => onFavorite(asset.catalogId)}
                >
                  {favorites.has(asset.catalogId) ? "★" : "☆"}
                </button>
                {armingId === asset.catalogId ? (
                  <span {...stylex.props(styles.absPulsing)} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : !loading ? (
        <div {...stylex.props(styles.centerText, styles.stackedLg)}>
          No gallery assets match this view.
        </div>
      ) : null}

      {error ? <p {...stylex.props(styles.relaxed2, styles.stackedLg)}>{error}</p> : null}
      {nextCursor ? (
        <button
          {...stylex.props(styles.borderedWide, styles.stackedLg)}
          disabled={loading}
          type="button"
          onClick={() => void loadMore()}
        >
          {loading ? "Loading…" : "Load 24 more"}
        </button>
      ) : loading ? (
        <p {...stylex.props(styles.centerText2, styles.stackedLg)}>Loading gallery…</p>
      ) : null}
    </div>
  );
}
