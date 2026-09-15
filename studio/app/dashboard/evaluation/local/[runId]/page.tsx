import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;

/** Kept as a deep link into the workspace with this machine's run open. */
export default async function LocalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/local/${runId}`);
  const query = new URLSearchParams({ section: "runs", local: runId });
  redirect(`/dashboard/evaluation?${query}`);
}
