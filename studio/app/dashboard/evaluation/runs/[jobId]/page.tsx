import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;

/**
 * A run is a selection inside the evaluation workspace, not a page of its own.
 * The URL stays, because it is in links, bookmarks and the desktop's history;
 * it resolves to the workspace with that run open.
 */
export default async function EvaluationRunPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/runs/${jobId}`);
  const query = new URLSearchParams({ section: "runs", run: jobId });
  redirect(`/dashboard/evaluation?${query}`);
}
