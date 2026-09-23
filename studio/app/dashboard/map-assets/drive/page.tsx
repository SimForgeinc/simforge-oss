import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { FreeDrive } from "./[mapVersionId]/FreeDrive";
import { DriveSession } from "./DriveSession";

/** Map launches author a scratch input; a bare route accepts an existing bench input path. */
export default async function FreeDriveEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ map?: string; scenario?: string }>;
}) {
  const { map: mapVersionId, scenario } = await searchParams;
  if (!mapVersionId) return <DriveSession initialScenario={scenario} />;
  await connection();
  const context = await requireAppContext("/dashboard/map-assets/drive");
  const map = (await listScenarioMapDescriptors(context)).find(
    (candidate) => candidate.mapVersionId === mapVersionId,
  );
  if (!map) notFound();

  return <FreeDrive map={map} />;
}
