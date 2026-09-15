import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
// Blocks rather than prerenders: this route resolves the app context. See ../page.tsx.
export const instant = false;
/**
 * A campaign is a selection inside the evaluation workspace, not a page of its
 * own. This URL is the parent of the policy and compare deep links, so it is
 * in links and bookmarks the same way they are and must resolve the same way —
 * it answered 404 while its own children resolved.
 *
 * Nothing static lives under `/dashboard/evaluation/<segment>`, so a truncated
 * deep link (`.../runs`, `.../local`) lands here too and opens the campaigns
 * section, which then says there is no ledger by that name. That is the honest
 * answer to a URL naming a campaign the runs root does not have.
 */
export default async function EvalCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/${campaignId}`);
  const query = new URLSearchParams({ section: "campaigns", campaign: campaignId });
  redirect(`/dashboard/evaluation?${query}`);
}
