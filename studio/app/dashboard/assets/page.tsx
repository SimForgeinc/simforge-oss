import { Suspense } from "react";
import * as stylex from "@stylexjs/stylex";
import { connection } from "next/server";
import { Skeleton } from "@simforge-oss/studio-ui/components/ui/skeleton";
import { listGalleryAssets } from "@/app/lib/asset-gallery/store";
import { requireAppContext } from "@/app/lib/db/app-context";
import { AssetGalleryClient } from "./AssetGalleryClient";
import { AssetGalleryGridSkeleton } from "./AssetGalleryGrid";
import { assetPage } from "./asset-surfaces.stylex";
import { AssetsTabs } from "./AssetsTabs";

const GALLERY_PAGE_SIZE = 24;

/**
 * The per-request half of the page: the session, and the first page of the
 * public catalog it is allowed to see.
 *
 * Split behind its own boundary rather than awaited at the top of the route.
 * `connection()` and the session read cannot be prerendered, and nothing under
 * the same boundary as them prerenders either — with the awaits at the top, the
 * whole gallery sat below the dashboard's generic route spinner and this page's
 * own chrome never reached the shell. Now the shelf streams into a placeholder
 * shaped like the catalog it is about to become.
 */
async function GalleryShelf() {
  await connection();
  const context = await requireAppContext("/dashboard/assets");
  const initialPage = await listGalleryAssets({
    viewerUserId: context.userId,
    limit: GALLERY_PAGE_SIZE,
  });
  return <AssetGalleryClient initialPage={initialPage} />;
}

/** Header block and tile grid at their real sizes, so the swap does not reflow. */
function GalleryShelfFallback() {
  return (
    <>
      <div {...stylex.props(assetPage.chrome)} aria-hidden="true">
        <div {...stylex.props(assetPage.measure)}>
          <Skeleton xstyle={assetPage.skeletonLabel} />
          <Skeleton xstyle={assetPage.skeletonTitle} />
          <Skeleton xstyle={assetPage.skeletonDescription} />
          <Skeleton xstyle={assetPage.skeletonButton} />
        </div>
      </div>
      <div {...stylex.props(assetPage.content)}>
        <div {...stylex.props(assetPage.measure)}>
          <AssetGalleryGridSkeleton />
        </div>
      </div>
    </>
  );
}

export default function AssetsPage() {
  return (
    <div {...stylex.props(assetPage.root)}>
      <AssetsTabs />
      <Suspense fallback={<GalleryShelfFallback />}>
        <GalleryShelf />
      </Suspense>
    </div>
  );
}
