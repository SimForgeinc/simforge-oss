import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { HOST_KIND } from "@/app/lib/host/kind";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;

/**
 * Kept as a deep link into the workspace with this machine's run open.
 *
 * A cloud host runs nothing on a machine of its own, so it has no local run to
 * open and the link is not part of that host.
 */
export default async function LocalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  if (HOST_KIND === "cloud") notFound();
  const { runId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/local/${runId}`);
  const query = new URLSearchParams({ section: "runs", local: runId });
  redirect(`/dashboard/evaluation?${query}`);
}
