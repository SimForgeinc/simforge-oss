import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { ScenarioDatasetsClient } from "@simforge-oss/studio-ui/scenario/ScenarioDatasetsClient";

export default async function ScenarioPage() {
  await connection();
  await requireAppContext("/dashboard/scenario");
  return <ScenarioDatasetsClient />;
}
