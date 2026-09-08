import { requireAppContext } from "@/app/lib/db/app-context";
import { LocalRunClient } from "./LocalRunClient";

export default async function LocalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  await requireAppContext(`/dashboard/evaluation/local/${runId}`);
  return <LocalRunClient runId={runId} />;
}
