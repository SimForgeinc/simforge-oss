import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";

/** Kept as a deep link into the workspace with this episode's playback open. */
export default async function EvalEpisodePage({
  params,
}: {
  params: Promise<{ campaignId: string; episodeId: string }>;
}) {
  const { campaignId, episodeId } = await params;
  await connection();
  await requireAppContext(`/dashboard/evaluation/${campaignId}/episodes/${episodeId}`);
  const query = new URLSearchParams({
    section: "campaigns",
    campaign: campaignId,
    episode: episodeId,
  });
  redirect(`/dashboard/evaluation?${query}`);
}
