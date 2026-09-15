import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";

/** Kept as a deep link into the workspace with this model version open. */
export default async function EvalVersionDetailPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const { versionId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/versions/${versionId}`);
  const query = new URLSearchParams({ section: "models", version: versionId });
  redirect(`/dashboard/evaluation?${query}`);
}
