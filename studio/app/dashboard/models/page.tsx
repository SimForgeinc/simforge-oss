import { requireAppContext } from "@/app/lib/db/app-context";
import { ModelsPageClient } from "./ModelsPageClient";

export default async function ModelsPage() {
  await requireAppContext("/dashboard/models");
  return <ModelsPageClient />;
}
