import { requireAppContext } from "@/app/lib/db/app-context";
import { CompareClient } from "./CompareClient";

/**
 * `?policy=<id>&policy=<id>[&policy=...]`, in order; the first is the baseline.
 *
 * Next gives a repeated query parameter as `string[]`, or `string` when it
 * appears once. Both are normalised here rather than in the client, so the
 * client only ever sees the ordered list.
 */
export default async function EvalComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ policy?: string | string[] }>;
}) {
  const { campaignId } = await params;
  const { policy } = await searchParams;
  const policies = typeof policy === "string" ? [policy] : (policy ?? []);
  await requireAppContext(`/dashboard/evaluation/${campaignId}/compare`);
  return <CompareClient campaignId={campaignId} policies={policies} />;
}
