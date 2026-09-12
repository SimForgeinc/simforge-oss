"use client";

import { Boxes, Loader2, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import {
  type GalleryActorClass,
  type GalleryAssetSummary,
} from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import { AssetDetailDrawer } from "./AssetDetailDrawer";
import { AssetGalleryGrid, AssetGalleryGridSkeleton } from "./AssetGalleryGrid";
import { AssetGalleryHeader, type GallerySection } from "./AssetGalleryHeader";
import { AssetGalleryToolbar } from "./AssetGalleryToolbar";
import { AssetGenerateDialog } from "./AssetGenerateDialog";
import { AssetUploadDialog, type AssetUploadKind } from "./AssetUploadDialog";
import { MapList } from "./MapList";
import { gallery } from "./asset-surfaces.stylex";
import {
  galleryVisibleAssets,
  type GalleryCarlaFilter,
  type GallerySort,
} from "./gallery-filters";

type GalleryPage = { items: GalleryAssetSummary[]; nextCursor: string | null };

const PAGE_SIZE = 24;
/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export function AssetGalleryClient({ initialPage }: { initialPage: GalleryPage }) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [actorClass, setActorClass] = useState<GalleryActorClass | "all">("all");
  const [carla, setCarla] = useState<GalleryCarlaFilter>("all");
  const [sort, setSort] = useState<GallerySort>("newest");
  const [section, setSection] = useState<GallerySection>("models");
  const [selected, setSelected] = useState<GalleryAssetSummary | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState<AssetUploadKind>("model");
  const [generateOpen, setGenerateOpen] = useState(false);
  // Bumped on publish so the Maps section refetches the catalog it just added to.
  const [mapReloadToken, setMapReloadToken] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [trimmedQuery]);

  /**
   * Re-list whenever a server-answered filter changes.
   *
   * The first run is deliberately skipped: `initialPage` is this exact query
   * already resolved on the server, so fetching it again would blank a grid
   * that is already correct. A ref rather than a key comparison, because
   * returning the controls to their defaults must still re-list — the user may
   * be clearing filters after a delete changed what the default page holds.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const abort = new AbortController();
    setReloading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (actorClass !== "all") params.set("actorClass", actorClass);
    void fetch(`/api/asset-gallery?${params}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("The asset gallery could not be loaded.");
        return (await response.json()) as GalleryPage;
      })
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "The asset gallery could not be loaded.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setReloading(false);
      });
    return () => abort.abort();
  }, [debouncedQuery, actorClass]);

  const loadMore = async () => {
    if (!nextCursor || appending) return;
    setAppending(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: nextCursor });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (actorClass !== "all") params.set("actorClass", actorClass);
      const response = await fetch(`/api/asset-gallery?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The asset gallery could not be loaded.");
      const page = (await response.json()) as GalleryPage;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset gallery could not be loaded.");
    } finally {
      setAppending(false);
    }
  };

  const visibleItems = useMemo(
    () => galleryVisibleAssets(items, carla, sort),
    [items, carla, sort],
  );

  const filtered = trimmedQuery !== "" || actorClass !== "all" || carla !== "all";

  const clearFilters = () => {
    setQuery("");
    setActorClass("all");
    setCarla("all");
  };

  const publish = (asset: GalleryAssetSummary) => {
    setItems((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
    setSelected(asset);
  };

  return (
    <div {...stylex.props(gallery.root)}>
      <AssetGalleryHeader
        section={section}
        onSectionChange={setSection}
        onGenerate={() => setGenerateOpen(true)}
        onUpload={() => {
          setUploadKind(section === "maps" ? "map" : "model");
          setUploadOpen(true);
        }}
      />

      {/* Model-only catalog controls are hidden for the compact map catalog. */}
      {section === "models" ? (
        <div {...stylex.props(gallery.toolbar)}>
          <AssetGalleryToolbar
            query={query}
            onQueryChange={setQuery}
            actorClass={actorClass}
            onActorClassChange={setActorClass}
            carla={carla}
            onCarlaChange={setCarla}
            sort={sort}
            onSortChange={setSort}
            resultCount={visibleItems.length}
            hasMore={nextCursor !== null}
            searching={reloading}
          />
        </div>
      ) : null}

      <main {...stylex.props(gallery.main)}>
        <div {...stylex.props(gallery.measure)}>
          {section === "maps" ? (
            <MapList
              reloadToken={mapReloadToken}
              onUpload={() => {
                setUploadKind("map");
                setUploadOpen(true);
              }}
            />
          ) : (
            <>
              {error ? (
                <p role="alert" {...stylex.props(gallery.alert)}>
                  {error}
                </p>
              ) : null}

              {reloading && visibleItems.length === 0 ? (
                <AssetGalleryGridSkeleton />
              ) : visibleItems.length > 0 ? (
                <AssetGalleryGrid assets={visibleItems} onSelect={setSelected} />
              ) : filtered ? (
                <EmptyState
                  icon={<SearchX {...stylex.props(gallery.icon)} />}
                  title="Nothing matches these filters"
                  description="No published asset fits this combination. Widen the search, or clear the filters to see the whole library again."
                  action={
                    <Button type="button" variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                  xstyle={gallery.emptyState}
                />
              ) : (
                <EmptyState
                  icon={<Boxes {...stylex.props(gallery.icon)} />}
                  title="The library is empty"
                  description="Generate a model from reference photos, or import a GLB you already have."
                  action={
                    <div {...stylex.props(gallery.actions)}>
                      <Button type="button" onClick={() => setGenerateOpen(true)}>
                        Generate a model
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setUploadKind("model");
                          setUploadOpen(true);
                        }}
                      >
                        Import a model
                      </Button>
                    </div>
                  }
                  xstyle={gallery.emptyState}
                />
              )}

              {nextCursor ? (
                <div {...stylex.props(gallery.loadMore)}>
                  <Button type="button" variant="outline" disabled={appending} onClick={() => void loadMore()}>
                    {appending ? <Loader2 aria-hidden="true" {...stylex.props(gallery.spinner)} /> : null}
                    {appending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>

      <AssetUploadDialog
        open={uploadOpen}
        initialKind={uploadKind}
        onOpenChange={setUploadOpen}
        onUploaded={publish}
        onMapPublished={() => {
          // The catalog now holds a version it did not a moment ago, and the user is
          // looking at the dialog that made it — land them on it when they close.
          setSection("maps");
          setMapReloadToken((token) => token + 1);
        }}
      />
      {/* Mounted only while open: the dialog owns an image picker, a poll loop
          and an in-flight generation, none of which should exist on a page the
          visitor is only browsing. */}
      {generateOpen ? (
        <AssetGenerateDialog
          open
          onClose={() => setGenerateOpen(false)}
          onPublished={(asset) => {
            publish(asset);
            setGenerateOpen(false);
          }}
        />
      ) : null}
      <AssetDetailDrawer
        asset={selected}
        onClose={() => setSelected(null)}
        onDeleted={(assetId) => setItems((current) => current.filter((item) => item.assetId !== assetId))}
        onRenamed={(renamed) => {
          setItems((current) => current.map((item) => (item.assetId === renamed.assetId ? renamed : item)));
          setSelected(renamed);
        }}
      />
    </div>
  );
}
