"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, MapPin } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { TopBarActionsPortal } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { MapCatalogToolbar } from "./MapCatalogToolbar";
import { MapCardGrid } from "./MapCardGrid";
import { MapCatalogMapView } from "./MapCatalogMapView";
import {
  buildCorpus,
  filterAssets,
  sortAssets,
  type CatalogView,
  type CatalogSort,
} from "./catalog-filters";

interface MapCatalogPageClientProps {
  assets: MapAsset[];
  runs: ScenarioSummary[];
}

function AddMapTopBarAction() {
  return (
    <TopBarActionsPortal>
      <Button asChild size="sm">
        <Link href="/dashboard/map-assets/new">
          <Plus className={stylex.props(styles.s_847).className} />
          Add map
        </Link>
      </Button>
    </TopBarActionsPortal>
  );
}

export function MapCatalogPageClient({ assets, runs: _runs }: MapCatalogPageClientProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CatalogSort>("date");
  const [view, setView] = useState<CatalogView>("grid");

  const corpora = useMemo(() => assets.map(buildCorpus), [assets]);

  const filtered = useMemo(() => {
    const matched = filterAssets(assets, corpora, query);
    return sortAssets(matched, sort);
  }, [assets, corpora, query, sort]);

  // Empty state
  if (assets.length === 0) {
    return (
      <>
        <AddMapTopBarAction />
        <EmptyState
          icon={<MapPin className={stylex.props(styles.s_946).className} />}
          title="No maps yet"
          description="Upload your first map to start exploring assets and building simulation scenarios."
          action={<Button asChild><Link href="/dashboard/map-assets/new"><Plus className={stylex.props(styles.s_219).className} />Add map</Link></Button>}
          xstyle={styles.s_220}
        />
      </>
    );
  }

  return (
    <>
      <AddMapTopBarAction />
      <div className={stylex.props(styles.s_353).className}>
        <MapCatalogToolbar
          query={query}
          onQueryChange={setQuery}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={setView}
          resultCount={filtered.length}
        />

        <div className={stylex.props(styles.s_206).className}>
          {view === "grid" ? (
            <div className={stylex.props(styles.s_207).className}>
              {filtered.length === 0 ? (
                <div className={stylex.props(styles.s_208).className}>
                  <p className={stylex.props(styles.s_209).className}>No maps match your search.</p>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className={stylex.props(styles.s_210).className}
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <MapCardGrid assets={filtered} />
              )}
            </div>
          ) : (
            <MapCatalogMapView assets={filtered} />
          )}
        </div>
      </div>
    </>
  );
}
