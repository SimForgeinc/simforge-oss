import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { MapLibrarySurface } from "@/app/host";

/**
 * The map library installs map closures on this installation's disk. A cloud
 * host streams every map from object storage and has no disk to install them
 * on, so the route does not exist there.
 */
export default async function MapLibraryPage() {
  if (MapLibrarySurface === null) notFound();
  await requireAppContext("/dashboard/map-library");
  return <MapLibrarySurface />;
}
