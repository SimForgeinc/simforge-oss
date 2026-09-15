import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;

/**
 * `?policy=<id>&policy=<id>[&policy=...]`, in order; the first is the baseline.
 *
 * Next gives a repeated query parameter as `string[]`, or `string` when it
 * appears once. Both are normalised here and handed to the workspace as the
 * same repeated `policy` parameter under `mode=compare`.
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
  await connection();
  await requireAppContext(`/dashboard/evaluation/${campaignId}/compare`);
  const query = new URLSearchParams({ section: "campaigns", campaign: campaignId });
  // Fewer than two columns is not a comparison; the campaign opens instead and
  // offers the launcher, which is what that URL used to show anyway.
  if (policies.length >= 2) {
    query.set("mode", "compare");
    for (const entry of policies) query.append("policy", entry);
  }
  redirect(`/dashboard/evaluation?${query}`);
}
