import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { ModelsSurface } from "@/app/host";

/**
 * The model store downloads weights onto this installation's disk and prepares
 * an isolated runtime for them. Neither exists on a cloud host, where models
 * run on managed capacity, so the route does not exist there.
 */
export default async function ModelsPage() {
  if (ModelsSurface === null) notFound();
  await requireAppContext("/dashboard/models");
  return <ModelsSurface />;
}
