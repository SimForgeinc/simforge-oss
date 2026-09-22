import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { FreeDrive } from "./[mapVersionId]/FreeDrive";

/**
 * Free-drive entry from the coverage atlas. This route intentionally resolves
 * only the requested map and never creates a scenario/document.
 */
export default async function FreeDriveEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ map?: string }>;
}) {
  const { map: mapVersionId } = await searchParams;
  if (!mapVersionId) notFound();
  await connection();
  const context = await requireAppContext("/dashboard/map-assets/drive");
  const map = (await listScenarioMapDescriptors(context)).find(
    (candidate) => candidate.mapVersionId === mapVersionId,
  );
  if (!map) notFound();

  return <FreeDrive map={map} />;
}
