import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { FreeDrive } from "./FreeDrive";

/**
 * Free drive: one map, one car, no clip.
 *
 * There is no document here — that is the point. The maps page hands this
 * route a map version and the browser builds a throwaway scenario holding a
 * single drivable car, so driving a map costs nothing and saves nothing. The
 * descriptor resolved here is everything the drive needs to lease the shared
 * world and place its car; the browser fetches no catalog of its own.
 */
export default async function FreeDrivePage({
  params,
}: {
  params: Promise<{ mapVersionId: string }>;
}) {
  const { mapVersionId } = await params;
  await connection();
  const context = await requireAppContext(`/dashboard/map-assets/drive/${mapVersionId}`);
  const map = (await listScenarioMapDescriptors(context)).find(
    (candidate) => candidate.mapVersionId === mapVersionId,
  );
  if (!map) notFound();

  return <FreeDrive map={map} />;
}
