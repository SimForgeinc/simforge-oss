import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-assets.stylex";
import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getMapAssets } from "@/app/lib/map-assets";
import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { MapGalleryPageClient } from "@/app/dashboard/map-assets/catalog/MapGalleryPageClient";
import MapAssetsLoading from "./loading";

async function MapAssetsContent() {
  await connection();
  await requireAppContext("/dashboard/map-assets");
  // The catalog is the union of what this computer holds and what the current
  // SimCloud authorization allows: real RFS always, other published maps only
  // with an active connection. Locked entries render with a connect prompt.
  const [assets, maps] = await Promise.all([getMapAssets(), listLocalMapCatalog()]);

  return (
    <div className={stylex.props(styles.s_779).className}>
      <MapGalleryPageClient assets={assets} maps={maps} />
    </div>
  );
}

export default function MapAssetsPage() {
  return (
    <Suspense fallback={<MapAssetsLoading />}>
      <MapAssetsContent />
    </Suspense>
  );
}
