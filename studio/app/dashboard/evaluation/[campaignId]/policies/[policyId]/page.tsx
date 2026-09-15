import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;

/** Kept as a deep link into the workspace with this policy run open. */
export default async function EvalPolicyDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string; policyId: string }>;
}) {
  const { campaignId, policyId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/${campaignId}/policies/${policyId}`);
  const query = new URLSearchParams({
    section: "campaigns",
    campaign: campaignId,
    policy: policyId,
  });
  redirect(`/dashboard/evaluation?${query}`);
}
