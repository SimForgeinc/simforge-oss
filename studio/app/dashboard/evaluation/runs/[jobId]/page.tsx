import { requireAppContext } from "@/app/lib/db/app-context";
import { RunDetailClient } from "./RunDetailClient";

export default async function EvaluationRunPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  await requireAppContext(`/dashboard/evaluation/runs/${jobId}`);
  return <RunDetailClient jobId={jobId} />;
}
