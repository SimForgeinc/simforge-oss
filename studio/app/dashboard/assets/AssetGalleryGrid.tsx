"use client";

import * as stylex from "@stylexjs/stylex";
import { Skeleton } from "@simforge-oss/studio-ui/components/ui/skeleton";
import type { GalleryAssetSummary } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import { AssetCard } from "./AssetCard";
import { grid } from "./asset-grid.stylex";


/**
 * A catalog is a list of things, so the grid is a real list: assistive tech
 * gets the item count from the markup instead of inferring it from a run of
 * sibling buttons, and the visible count in the toolbar has something to agree
 * with.
 */
export function AssetGalleryGrid({
  assets,
  onSelect,
}: {
  assets: readonly GalleryAssetSummary[];
  onSelect: (asset: GalleryAssetSummary) => void;
}) {
  return (
    <ul {...stylex.props(grid.grid, grid.list)}>
      {assets.map((asset) => (
        <li key={asset.catalogId}>
          <AssetCard asset={asset} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown while a filter change is in flight and nothing is on screen yet.
 *
 * The tiles are shaped like real ones — square thumbnail, two text lines — so
 * the swap does not reflow the page, and the region is `aria-hidden` with a
 * live status beside it: a screen reader wants "loading assets" once, not nine
 * placeholder cards.
 */
export function AssetGalleryGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <>
      <p role="status" {...stylex.props(grid.srOnly)}>
        Loading assets…
      </p>
      <div aria-hidden="true" {...stylex.props(grid.grid)}>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} {...stylex.props(grid.skeletonCard)}>
            <Skeleton xstyle={grid.skeletonThumb} />
            <div {...stylex.props(grid.skeletonBody)}>
              <div {...stylex.props(grid.skeletonRow)}>
                <Skeleton xstyle={grid.skeletonTitle} />
                <Skeleton xstyle={grid.skeletonChip} />
              </div>
              <div {...stylex.props(grid.skeletonRow)}>
                <Skeleton xstyle={grid.skeletonMeta} />
                <Skeleton xstyle={grid.skeletonMetaShort} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
