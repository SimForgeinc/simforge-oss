import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { buildRows, catalog } from "./carla-catalog";
import { CarlaAssetsPageClient } from "./CarlaAssetsPageClient";

export default async function CarlaAssetsPage() {
  await connection();
  await requireAppContext("/dashboard/assets/carla");
  return <CarlaAssetsPageClient rows={buildRows(catalog)} counts={catalog.counts} version={catalog.carlaVersion} />;
}
