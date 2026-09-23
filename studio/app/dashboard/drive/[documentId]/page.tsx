import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getScenarioDocument } from "@/app/lib/scenario/document-store";
import { resolveDriverRole } from "@/app/lib/scenario/driver-in-the-loop";
import { DriverInTheLoopDrive } from "./DriverInTheLoopDrive";

/** Resolve the authored policy subject; the bench executes it without mutating the document. */
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
      mapVersionId={document.mapVersionId}
      mapSourceMapId={document.mapSourceMapId}
      mapXodrSha256={document.mapXodrSha256}
      roleId={role.roleId}
      title={document.title}
    />
  );
}
