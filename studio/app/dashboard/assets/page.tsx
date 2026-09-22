import { connection } from "next/server";
import { listGalleryAssets } from "@/app/lib/asset-gallery/store";
import { requireAppContext } from "@/app/lib/db/app-context";
import { AssetGalleryPageClient } from "./AssetGalleryPageClient";

const GALLERY_PAGE_SIZE = 24;
export default async function AssetsPage() {
  await connection();
  const context = await requireAppContext("/dashboard/assets");
  const initialPage = await listGalleryAssets({
    viewerUserId: context.userId,
    limit: GALLERY_PAGE_SIZE,
  });
  return <AssetGalleryPageClient initialPage={initialPage} />;
}

