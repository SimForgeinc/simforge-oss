import { requireAppContext } from "@/app/lib/db/app-context";
import { MapLibraryClient } from "./MapLibraryClient";

export default async function MapLibraryPage() {
  await requireAppContext("/dashboard/map-library");
  return <MapLibraryClient />;
}
