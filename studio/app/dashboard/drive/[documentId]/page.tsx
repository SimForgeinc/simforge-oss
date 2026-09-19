import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getScenarioDocument } from "@/app/lib/scenario/document-store";
import { resolveDriverRole } from "@/app/lib/scenario/driver-in-the-loop";
import { DriverInTheLoopDrive } from "./DriverInTheLoopDrive";

/**
 * The Driver in the Loop drive: one scenario, one actor, one clip.
 *
 * The document is already the variation the list created, so this page only
 * resolves which actor the human takes over and hands the drive the content it
 * needs. Driving happens on its own route because the session owns the whole
 * screen and its own viewer.
 */
export default async function DriverInTheLoopPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentId: string }>;
  searchParams: Promise<{ actor?: string }>;
}) {
  const { documentId } = await params;
  await connection();
  const context = await requireAppContext(`/dashboard/drive/${documentId}`);
  const document = await getScenarioDocument(context, documentId);
  if (!document || !document.mapVersionId) notFound();

  const { actor } = await searchParams;
  const role = resolveDriverRole(document.content, actor);
  if (!role.ok) notFound();

  return (
    <DriverInTheLoopDrive
      content={document.content}
      datasetId={document.datasetId}
      documentId={document.id}
      draftVersion={document.draftVersion}
      mapVersionId={document.mapVersionId}
      mapSourceMapId={document.mapSourceMapId}
      mapXodrSha256={document.mapXodrSha256}
      roleId={role.roleId}
      title={document.title}
    />
  );
}
